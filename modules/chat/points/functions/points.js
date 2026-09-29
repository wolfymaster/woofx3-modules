/// <reference types="@woofx3/module-sdk/function-ctx" />

// Loyalty points: viewers earn by chatting, spend by gambling or giving, and
// workflows can hand out bonuses (a follow, a raid, a sub).
//
// Storage layout. Every value is stored as a JSON *string* this file
// serialises itself, because compareAndSet compares the stored bytes: handing
// back the exact string that was read is what makes the comparison reliable.
//
//   viewer:<twitchUserId>  {"id","name","points","earnedAt","gambledAt"}
//   name:<lowercased name> "<twitchUserId>"
//   pending:<lowercased name> {"name","points"}
//   leaderboard            [{"key","name","points"}], highest first
//
// Why key by id rather than by name: a chat message carries the chatter's
// stable Twitch id, and keying on it means a viewer who renames keeps their
// points. But commands name people ("!give wolfy 50") and most event payloads
// (follow, raid, sub) carry only a display name, so a name index resolves
// those to an id. Twitch display names differ from logins only by case for
// almost everyone, so the index keys on the lowercased display name.
//
// A name nobody has seen in chat yet (a follower who has never typed) has no
// id to resolve to. Points given to them land in pending:<name> and are
// folded into their real record the first time they chat, rather than being
// refused or lost.

var LEADERBOARD_SIZE = 25;
var LEADERBOARD_SHOWN = 5;
var CAS_ATTEMPTS = 6;
// Events a single run may ask the engine to publish is capped at 16.
var MAX_EVENTS = 16;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Runs on every chat message (the bundled workflow binds it to user.message):
 * awards chat points, then answers any points command in the message.
 * Commands are handled here rather than as manifest commands because the
 * command event carries only the chatter's name, and !addpoints must know
 * whether the chatter is a moderator, which only the chat message says.
 *
 * @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx
 */
function handle_chat_message(ctx) {
    var run = newRun(ctx);
    var data = (ctx.event && ctx.event.data) || {};
    var chatterId = str(data.chatterId);
    var chatterName = str(data.chatterName);
    var message = str(data.message).trim();
    var membership = data.membership || {};

    if (!chatterId || !chatterName) {
        return finish(run, { handled: false, reason: "not a chat message" });
    }

    rememberName(run, chatterId, chatterName);
    var earned = awardChatPoints(run, chatterId, chatterName, membership);

    var outcome = { handled: true, earned: earned, command: "" };
    if (message.charAt(0) === "!") {
        outcome.command = runCommand(run, chatterId, chatterName, membership, message);
    }
    return finish(run, outcome);
}

/**
 * Workflow action: add (or, with a negative amount, remove) points.
 *
 * @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx
 */
function give_points(ctx) {
    var run = newRun(ctx);
    var params = (ctx.event && ctx.event.parameters) || {};
    var who = str(params.user).trim();
    var amount = Math.trunc(Number(params.amount));
    var reason = str(params.reason).trim() || "bonus";

    if (!who) {
        throw new Error("user must name a viewer.");
    }
    if (!isFinite(amount) || amount === 0) {
        throw new Error("amount must be a whole number other than 0.");
    }

    var target = resolveViewer(run, who);
    var change = adjust(run, target, amount, reason);
    return finish(run, {
        user: change.name,
        points: change.points,
        delta: change.delta
    });
}

/**
 * Workflow action: read a viewer's balance.
 *
 * @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx
 */
function get_points(ctx) {
    var run = newRun(ctx);
    var params = (ctx.event && ctx.event.parameters) || {};
    var who = str(params.user).trim();
    if (!who) {
        throw new Error("user must name a viewer.");
    }
    var target = resolveViewer(run, who);
    var record = readRecord(run, target);
    return finish(run, {
        user: record ? record.name : target.name,
        points: record ? record.points : 0
    });
}

// ---------------------------------------------------------------------------
// Chat commands
// ---------------------------------------------------------------------------

function runCommand(run, chatterId, chatterName, membership, message) {
    var parts = message.split(/\s+/);
    var command = parts[0].toLowerCase();
    var args = parts.slice(1);
    var self = { key: "viewer:" + chatterId, id: chatterId, name: chatterName };
    var isMod = membership.isModerator === true || membership.isBroadcaster === true;

    // "!points" always works; "!<currency>" (e.g. !bones) is an alias so the
    // command matches whatever the streamer calls their points.
    var currencyCommand = "!" + currencyName(run).toLowerCase().replace(/\s+/g, "");

    if (command === "!points" || command === currencyCommand) {
        commandBalance(run, self, args);
        return "points";
    }
    if (command === "!give") {
        commandGive(run, self, args);
        return "give";
    }
    if (command === "!gamble") {
        commandGamble(run, self, args);
        return "gamble";
    }
    if (command === "!leaderboard" || command === "!top") {
        commandLeaderboard(run);
        return "leaderboard";
    }
    if (command === "!addpoints" || command === "!removepoints") {
        // Silently ignored for non-mods: answering would invite spam.
        if (!isMod) {
            return "";
        }
        commandModAdjust(run, args, command === "!addpoints" ? 1 : -1);
        return command.slice(1);
    }
    return "";
}

function commandBalance(run, self, args) {
    var target = self;
    if (args.length > 0) {
        target = resolveViewer(run, args[0]);
    }
    var record = readRecord(run, target);
    var points = record ? record.points : 0;
    var name = record ? record.name : target.name;
    say(run, "@" + name + " has " + formatPoints(run, points) + ".");
}

function commandGive(run, self, args) {
    var amount = parseWhole(args[1]);
    if (!args[0] || amount === null || amount <= 0) {
        say(run, "@" + self.name + " usage: !give <user> <amount>");
        return;
    }
    var target = resolveViewer(run, args[0]);
    if (target.key === self.key) {
        say(run, "@" + self.name + " you can't give points to yourself.");
        return;
    }

    // Two records, no transaction: take from the giver first, so a failure
    // part-way can only ever leave points missing from the giver, and then
    // refund them if the credit doesn't land.
    var debit = adjust(run, self, -amount, "give", { requireFunds: true });
    if (!debit.ok) {
        say(run, "@" + self.name + " you only have " + formatPoints(run, debit.points) + ".");
        return;
    }
    try {
        adjust(run, target, amount, "gift from " + self.name);
    } catch (err) {
        adjust(run, self, amount, "refund");
        throw err;
    }
    say(run, "@" + self.name + " gave " + formatPoints(run, amount) + " to " + target.name + ".");
}

function commandGamble(run, self, args) {
    var settings = run.ctx.module.settings || {};
    if (!isOn(settings.gambleEnabled)) {
        return;
    }

    var record = readRecord(run, self);
    var balance = record ? record.points : 0;
    var wager = parseWager(args[0], balance);
    if (wager === null || wager <= 0) {
        say(run, "@" + self.name + " usage: !gamble <amount|half|all>");
        return;
    }
    if (wager > balance) {
        say(run, "@" + self.name + " you only have " + formatPoints(run, balance) + ".");
        return;
    }

    var cooldownMs = nonNegative(settings.gambleCooldownSeconds, 0) * 1000;
    var now = Date.now();
    var won = Math.random() < 0.5;
    var cooling = false;

    // The cooldown check, the balance check and the payout happen inside one
    // compare-and-set, so two quick !gamble messages can't both pass the
    // cooldown or both spend the same points.
    var change = mutate(run, self, function (current) {
        if (cooldownMs > 0 && current.gambledAt && now - current.gambledAt < cooldownMs) {
            cooling = true;
            return null;
        }
        if (current.points < wager) {
            return null;
        }
        current.points += won ? wager : -wager;
        current.gambledAt = now;
        return current;
    }, won ? wager : -wager, "gamble");

    if (cooling) {
        var wait = Math.ceil((cooldownMs - (now - change.record.gambledAt)) / 1000);
        say(run, "@" + self.name + " you can gamble again in " + wait + "s.");
        return;
    }
    if (!change.ok) {
        say(run, "@" + self.name + " you only have " + formatPoints(run, change.points) + ".");
        return;
    }
    say(run, "@" + self.name + (won ? " won " : " lost ") + formatPoints(run, wager) +
        " and now has " + formatPoints(run, change.points) + ".");
}

function commandLeaderboard(run) {
    var board = readLeaderboard(run).entries.slice(0, LEADERBOARD_SHOWN);
    if (board.length === 0) {
        say(run, "Nobody has any " + currencyName(run) + " yet.");
        return;
    }
    var lines = [];
    for (var i = 0; i < board.length; i++) {
        lines.push((i + 1) + ". " + board[i].name + " (" + board[i].points + ")");
    }
    say(run, "Top " + currencyName(run) + ": " + lines.join(", "));
}

function commandModAdjust(run, args, sign) {
    var amount = parseWhole(args[1]);
    if (!args[0] || amount === null || amount <= 0) {
        say(run, "Usage: " + (sign > 0 ? "!addpoints" : "!removepoints") + " <user> <amount>");
        return;
    }
    var target = resolveViewer(run, args[0]);
    var change = adjust(run, target, sign * amount, sign > 0 ? "added by mod" : "removed by mod");
    say(run, change.name + " now has " + formatPoints(run, change.points) + ".");
}

// ---------------------------------------------------------------------------
// Earning
// ---------------------------------------------------------------------------

function awardChatPoints(run, chatterId, chatterName, membership) {
    var settings = run.ctx.module.settings || {};
    var base = nonNegative(settings.pointsPerMessage, 5);
    if (base === 0) {
        return 0;
    }
    var multiplier = membership.isSubscriber === true ? nonNegative(settings.subscriberMultiplier, 2) : 1;
    var award = Math.floor(base * multiplier);
    if (award <= 0) {
        return 0;
    }
    var cooldownMs = nonNegative(settings.messageCooldownSeconds, 60) * 1000;
    var now = Date.now();

    var change = mutate(run, { key: "viewer:" + chatterId, id: chatterId, name: chatterName }, function (current) {
        if (current.earnedAt && now - current.earnedAt < cooldownMs) {
            return null;
        }
        current.points += award;
        current.earnedAt = now;
        current.name = chatterName;
        return current;
    }, award, "chat");

    return change.ok ? award : 0;
}

// Keep name:<lower> pointing at this chatter, and fold in anything given to
// that name before we knew their id. Only runs when the index is missing or
// stale, so a regular chatter costs one read here, not a write.
function rememberName(run, chatterId, chatterName) {
    var nameKey = "name:" + chatterName.toLowerCase();
    var indexed = run.ctx.storage.get(nameKey);
    if (indexed === JSON.stringify(chatterId)) {
        return;
    }
    run.ctx.storage.set(nameKey, JSON.stringify(chatterId));

    var pendingKey = "pending:" + chatterName.toLowerCase();
    var claimed = 0;
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var raw = run.ctx.storage.get(pendingKey);
        var pending = parseJson(raw);
        if (!pending || !(pending.points > 0)) {
            return;
        }
        var emptied = JSON.stringify({ name: pending.name, points: 0 });
        if (run.ctx.storage.compareAndSet(pendingKey, raw, emptied).swapped) {
            claimed = pending.points;
            break;
        }
    }
    if (claimed > 0) {
        adjust(run, { key: "viewer:" + chatterId, id: chatterId, name: chatterName }, claimed, "carried over");
        // The pending entry sat on the leaderboard under its own key.
        updateLeaderboard(run, pendingKey, chatterName, 0);
    }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

// A name or numeric id from a command or workflow step, to the record key it
// lives under.
function resolveViewer(run, who) {
    var cleaned = str(who).trim().replace(/^@/, "");
    if (/^[0-9]+$/.test(cleaned)) {
        return { key: "viewer:" + cleaned, id: cleaned, name: cleaned };
    }
    var lower = cleaned.toLowerCase();
    var id = parseJson(run.ctx.storage.get("name:" + lower));
    if (typeof id === "string" && id) {
        return { key: "viewer:" + id, id: id, name: cleaned };
    }
    return { key: "pending:" + lower, id: "", name: cleaned };
}

function readRecord(run, target) {
    var record = parseJson(run.ctx.storage.get(target.key));
    if (!record || typeof record !== "object") {
        return null;
    }
    record.points = Number(record.points) || 0;
    return record;
}

// Add delta to a record, clamping at zero. With requireFunds, a debit that
// would go below zero is refused instead (ok: false) and leaves it untouched.
function adjust(run, target, delta, reason, opts) {
    var requireFunds = !!(opts && opts.requireFunds);
    return mutate(run, target, function (current) {
        if (requireFunds && current.points + delta < 0) {
            return null;
        }
        current.points = Math.max(0, current.points + delta);
        return current;
    }, delta, reason);
}

// Read-modify-write one record under compareAndSet, retrying from whatever
// won a race. `change` returns the new record, or null to leave it as is.
// Returns { ok, points, delta, name, record } with delta as actually applied.
function mutate(run, target, change, intendedDelta, reason) {
    var storage = run.ctx.storage;
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var raw = storage.get(target.key);
        var current = parseJson(raw);
        if (!current || typeof current !== "object") {
            current = { id: target.id, name: target.name, points: 0, earnedAt: 0, gambledAt: 0 };
            raw = null;
        }
        current.points = Number(current.points) || 0;
        var before = current.points;

        var next = change(JSON.parse(JSON.stringify(current)));
        if (!next) {
            return { ok: false, points: before, delta: 0, name: current.name, record: current };
        }

        var result = storage.compareAndSet(target.key, raw, JSON.stringify(next));
        if (result.swapped) {
            var applied = next.points - before;
            if (applied !== 0) {
                updateLeaderboard(run, target.key, next.name, next.points);
                queueEvent(run, next.name, next.points, applied, reason);
            }
            return { ok: true, points: next.points, delta: applied, name: next.name, record: next };
        }
    }
    throw new Error("points for " + target.name + " kept changing underneath this update; try again.");
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function readLeaderboard(run) {
    var raw = run.ctx.storage.get("leaderboard");
    var entries = parseJson(raw);
    return { raw: raw === undefined ? null : raw, entries: Array.isArray(entries) ? entries : [] };
}

// Keep one small top-N list current on every write, since storage can't list
// keys. Skips the write when the change can't affect the list.
function updateLeaderboard(run, key, name, points) {
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var board = readLeaderboard(run);
        var entries = board.entries;
        var at = -1;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].key === key) { at = i; break; }
        }
        var full = entries.length >= LEADERBOARD_SIZE;
        var lowest = entries.length > 0 ? entries[entries.length - 1].points : 0;
        if (at === -1 && (points <= 0 || (full && points <= lowest))) {
            return;
        }
        if (at !== -1 && entries[at].points === points && entries[at].name === name) {
            return;
        }

        var next = entries.filter(function (e) { return e.key !== key; });
        if (points > 0) {
            next.push({ key: key, name: name, points: points });
        }
        next.sort(function (a, b) { return b.points - a.points; });
        next = next.slice(0, LEADERBOARD_SIZE);

        if (run.ctx.storage.compareAndSet("leaderboard", board.raw, JSON.stringify(next)).swapped) {
            return;
        }
    }
    // Losing a leaderboard race repeatedly isn't worth failing a balance
    // change that already landed; the next write corrects it.
    run.ctx.log.warn("leaderboard update gave up after repeated conflicts");
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function newRun(ctx) {
    return { ctx: ctx, events: [] };
}

function queueEvent(run, name, points, delta, reason) {
    if (run.events.length >= MAX_EVENTS) {
        return;
    }
    run.events.push({
        type: "points.changed",
        data: { user: name, points: points, delta: delta, reason: reason }
    });
}

// Hand back the value along with any points.changed events. An engine
// without ctx.result just gets the value.
function finish(run, value) {
    if (run.events.length > 0 && typeof run.ctx.result === "function") {
        return run.ctx.result(value, run.events);
    }
    return value;
}

function say(run, text) {
    if (!run.ctx.chat || typeof run.ctx.chat.sendMessage !== "function") {
        throw new Error("ctx.chat.sendMessage is not available on this engine.");
    }
    run.ctx.chat.sendMessage(text);
}

function currencyName(run) {
    var settings = run.ctx.module.settings || {};
    return str(settings.currencyName).trim() || "points";
}

function formatPoints(run, n) {
    return n + " " + currencyName(run);
}

function parseWhole(value) {
    var s = str(value).trim();
    if (!/^[0-9]+$/.test(s)) {
        return null;
    }
    return parseInt(s, 10);
}

function parseWager(value, balance) {
    var s = str(value).trim().toLowerCase();
    if (s === "all") { return balance; }
    if (s === "half") { return Math.floor(balance / 2); }
    return parseWhole(s);
}

function nonNegative(value, fallback) {
    var n = Number(value);
    if (value === undefined || value === null || value === "" || !isFinite(n) || n < 0) {
        return fallback;
    }
    return n;
}

function isOn(value) {
    return value === true || value === "true";
}

function str(value) {
    return value === undefined || value === null ? "" : String(value);
}

function parseJson(raw) {
    if (typeof raw !== "string" || raw === "") {
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        return null;
    }
}
