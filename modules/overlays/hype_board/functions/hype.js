/// <reference types="@woofx3/module-sdk/function-ctx" />

// Hype Board: counts bits, subs and tips, crowns the biggest supporter of
// each, and runs a subathon timer those events add time to. The board widget
// only reads storage; everything it shows is written here.
//
// Storage layout. Values are JSON *strings* this file serialises itself,
// because compareAndSet compares the stored bytes: handing back the exact
// string that was read is what makes the comparison reliable.
//
//   board     {"round","currency","subs","bits","tipsCents",
//              "bosses":{"bits"|"gifts"|"tips": {"key","name","amount"} | null},
//              "updatedAt"}
//   fan:<round>:<kind>:<name key>   a supporter's running total for one kind
//   subathon  {"status":"idle"|"running"|"paused","endsAt","remainingMs",
//              "pausedBy","updatedAt"}
//
// Why `round` is in each fan key: storage can't be listed or deleted from a
// sandbox, so a reset can't clear every supporter's tally. Starting a new
// round instead makes the old tallies unreachable. By default everything is
// written clearOnSessionEnd, and the engine clears it all; with "Keep totals
// between streams" the orphaned tallies are a few bytes per supporter, left
// behind only when the streamer resets.
//
// The subathon timer is never cleared with the session: a subathon commonly
// spans several streams, and pausing while offline is what carries it over.

var CAS_ATTEMPTS = 8;
var KINDS = ["bits", "gifts", "tips"];
var TIER_MULTIPLIER = { "1000": 1, "2000": 2, "3000": 5 };
var DEFAULT_START_MINUTES = 60;
var DEFAULT_SECONDS_PER_SUB = 60;
var DEFAULT_SECONDS_PER_100_BITS = 12;
var DEFAULT_SECONDS_PER_TIP = 12;

// ---------------------------------------------------------------------------
// Event entry points (run by the module's own workflows)
// ---------------------------------------------------------------------------

/** channel.cheer: { userName, isAnonymous, amount } */
function record_cheer(ctx) {
    var data = eventData(ctx);
    var bits = wholeNumber(data.amount);
    if (bits <= 0) {
        return { bits: readBoard(ctx).board.bits, skipped: "no bits" };
    }
    var who = supporter(data.isAnonymous ? "" : data.userName);
    var board = recordSupport(ctx, "bits", who, bits, { bits: bits });
    addEarnedTime(ctx, bits / 100 * setting(ctx, "secondsPer100Bits", DEFAULT_SECONDS_PER_100_BITS));
    return { bits: board.bits };
}

/**
 * channel.subscribe and channel.resub. A gifted sub arrives here once per
 * recipient *and* on channel.subscriptionGift for the whole bundle, so gifted
 * subs are skipped here and counted for the gifter by record_gift.
 */
function record_sub(ctx) {
    var data = eventData(ctx);
    if (data.isGift === true) {
        return { subs: readBoard(ctx).board.subs, skipped: "gifted subs are counted for the gifter" };
    }
    var board = recordTotals(ctx, { subs: 1 });
    addEarnedTime(ctx, tierMultiplier(data.tier) * setting(ctx, "secondsPerSub", DEFAULT_SECONDS_PER_SUB));
    return { subs: board.subs };
}

/** channel.subscriptionGift: { gifterName, isAnonymous, amount, tier } */
function record_gift(ctx) {
    var data = eventData(ctx);
    var count = wholeNumber(data.amount);
    if (count <= 0) {
        return { subs: readBoard(ctx).board.subs, skipped: "no subs" };
    }
    var who = supporter(data.isAnonymous ? "" : data.gifterName);
    var board = recordSupport(ctx, "gifts", who, count, { subs: count });
    addEarnedTime(ctx, count * tierMultiplier(data.tier) * setting(ctx, "secondsPerSub", DEFAULT_SECONDS_PER_SUB));
    return { subs: board.subs };
}

/**
 * Tips from any of the payment modules. Each names the supporter and the
 * amount under its own field, so this takes whichever is present. Mixed
 * currencies are added as they come: the board assumes one currency.
 */
function record_tip(ctx) {
    var data = eventData(ctx);
    if (data.isTest === true) {
        return { tips: tipsUnits(readBoard(ctx).board), skipped: "test tip" };
    }
    var amount = Number(firstDefined(data.amount, data.price));
    var cents = Number.isFinite(amount) ? Math.round(amount * 100) : 0;
    if (cents <= 0) {
        return { tips: tipsUnits(readBoard(ctx).board), skipped: "no amount" };
    }
    var who = supporter(firstDefined(data.fromName, data.supporterName, data.gifterUsername, data.username));
    var board = recordSupport(ctx, "tips", who, cents, { tipsCents: cents });
    addEarnedTime(ctx, (cents / 100) * setting(ctx, "secondsPerTip", DEFAULT_SECONDS_PER_TIP));
    return { tips: tipsUnits(board) };
}

/** stream.online / stream.offline, with parameters.live. */
function set_live(ctx) {
    var params = eventParams(ctx);
    var live = params.live === true || params.live === "true";
    if (toggle(ctx, "pauseWhenOffline", true)) {
        if (live) {
            // Only undo a pause the stream ending caused: a timer a moderator
            // paused stays paused until they resume it.
            updateTimer(ctx, function (t, now) {
                return t.status === "paused" && t.pausedBy === "offline" ? resumed(t, now) : null;
            });
        } else {
            updateTimer(ctx, function (t, now) {
                return t.status === "running" ? paused(t, now, "offline") : null;
            });
        }
    }
    return { live: live };
}

// ---------------------------------------------------------------------------
// Chat commands (run on every chat message)
// ---------------------------------------------------------------------------

// Handled from the chat message rather than as manifest commands because the
// command event carries only the chatter's name, and running the timer needs
// to know whether the chatter is a moderator, which only the message says.
function handle_chat_message(ctx) {
    var data = eventData(ctx);
    var message = str(data.message).trim();
    var words = message.split(/\s+/);
    var command = words[0].toLowerCase();
    if (command !== "!subathon" && command !== "!resetboard") {
        return { command: "" };
    }

    var membership = data.membership || {};
    var isMod = membership.isModerator === true || membership.isBroadcaster === true;
    var sub = (words[1] || "").toLowerCase();

    if (command === "!resetboard") {
        if (!isMod) {
            return { command: "" };
        }
        resetBoard(ctx);
        say(ctx, "The Hype Board is back to zero. Let's go!");
        return { command: "resetboard" };
    }

    if (sub === "" || !isMod) {
        say(ctx, timerStatusLine(currentTimer(ctx), Date.now()));
        return { command: "subathon" };
    }

    var t;
    switch (sub) {
        case "start": {
            var length = words[2] ? parseDuration(words[2]) : startLengthMs(ctx);
            if (length === null || length <= 0) {
                say(ctx, "Try !subathon start 4h, 90m or 1h30m.");
                return { command: "subathon start" };
            }
            t = startTimer(ctx, length);
            say(ctx, "The subathon is on! " + formatDuration(remainingMs(t, Date.now())) + " on the clock.");
            return { command: "subathon start" };
        }
        case "pause":
            t = updateTimer(ctx, function (cur, now) {
                return cur.status === "running" ? paused(cur, now, "mod") : null;
            });
            say(ctx, t.status === "paused" ? "Subathon timer paused at " + formatDuration(t.remainingMs) + "." : timerStatusLine(t, Date.now()));
            return { command: "subathon pause" };
        case "resume":
            t = updateTimer(ctx, function (cur, now) {
                return cur.status === "paused" ? resumed(cur, now) : null;
            });
            say(ctx, timerStatusLine(t, Date.now()));
            return { command: "subathon resume" };
        case "add":
        case "remove": {
            var amount = words[2] ? parseDuration(words[2]) : null;
            if (amount === null || amount <= 0) {
                say(ctx, "Try !subathon " + sub + " 10m.");
                return { command: "subathon " + sub };
            }
            t = addTime(ctx, sub === "add" ? amount : -amount, true);
            say(ctx, t.status === "idle"
                ? "There's no subathon running. Start one with !subathon start."
                : (sub === "add" ? "Added " : "Took away ") + formatDuration(amount) + ". " + timerStatusLine(t, Date.now()));
            return { command: "subathon " + sub };
        }
        case "end":
        case "stop":
            writeTimer(ctx, idleTimer());
            say(ctx, "The subathon timer is done. Thank you all!");
            return { command: "subathon end" };
        default:
            say(ctx, "Subathon commands: start, pause, resume, add, remove, end.");
            return { command: "subathon" };
    }
}

// ---------------------------------------------------------------------------
// Action entry points (for workflows, buttons and stream decks)
// ---------------------------------------------------------------------------

function start_timer(ctx) {
    var minutes = Number(eventParams(ctx).minutes);
    var length = Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : startLengthMs(ctx);
    return timerResult(startTimer(ctx, length));
}

function pause_timer(ctx) {
    return timerResult(updateTimer(ctx, function (t, now) {
        return t.status === "running" ? paused(t, now, "mod") : null;
    }));
}

function resume_timer(ctx) {
    return timerResult(updateTimer(ctx, function (t, now) {
        return t.status === "paused" ? resumed(t, now) : null;
    }));
}

function add_time(ctx) {
    var minutes = Number(eventParams(ctx).minutes);
    if (!Number.isFinite(minutes) || minutes === 0) {
        return timerResult(currentTimer(ctx));
    }
    return timerResult(addTime(ctx, minutes * 60000, true));
}

function end_timer(ctx) {
    writeTimer(ctx, idleTimer());
    return { remainingMs: 0 };
}

function reset_totals(ctx) {
    resetBoard(ctx);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function emptyBoard(ctx) {
    return {
        round: String(Date.now()) + Math.floor(Math.random() * 1e6),
        currency: currencySymbol(ctx),
        subs: 0,
        bits: 0,
        tipsCents: 0,
        bosses: { bits: null, gifts: null, tips: null },
        updatedAt: Date.now()
    };
}

function readBoard(ctx) {
    var raw = ctx.storage.get("board");
    var board = parseJson(raw);
    if (!board || typeof board !== "object" || !board.round) {
        board = emptyBoard(ctx);
    }
    return { raw: raw === undefined ? null : raw, board: board };
}

// The board as stored, creating it first when there is none, so the round a
// supporter's tally is filed under is the one the board keeps.
function ensureBoard(ctx) {
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var read = readBoard(ctx);
        if (read.raw !== null && parseJson(read.raw) && parseJson(read.raw).round) {
            return read.board;
        }
        if (ctx.storage.compareAndSet("board", read.raw, JSON.stringify(read.board), storeOptions(ctx)).swapped) {
            return read.board;
        }
    }
    throw new Error("the Hype Board kept changing underneath this update; try again.");
}

function resetBoard(ctx) {
    ctx.storage.set("board", JSON.stringify(emptyBoard(ctx)), storeOptions(ctx));
}

function recordTotals(ctx, add) {
    return updateBoard(ctx, function (board) {
        return addTotals(board, add);
    });
}

// Adds to a supporter's tally, then to the board's totals, taking the boss
// spot when the tally now beats it. The tally lands first so that two
// supporters racing for the spot each compare against their real total.
function recordSupport(ctx, kind, who, amount, add) {
    var round = ensureBoard(ctx).round;
    var tally = updateNumber(ctx, "fan:" + round + ":" + kind + ":" + who.key, amount);

    return updateBoard(ctx, function (board) {
        addTotals(board, add);
        // A reset between the two writes started a new round; this tally
        // belongs to the old one, so count the gift in the new round alone.
        var total = board.round === round ? tally : amount;
        var boss = board.bosses[kind];
        if (!boss || boss.key === who.key || total > boss.amount) {
            board.bosses[kind] = { key: who.key, name: who.name, amount: total };
        }
        return board;
    });
}

function addTotals(board, add) {
    board.subs = (Number(board.subs) || 0) + (add.subs || 0);
    board.bits = (Number(board.bits) || 0) + (add.bits || 0);
    board.tipsCents = (Number(board.tipsCents) || 0) + (add.tipsCents || 0);
    return board;
}

function updateBoard(ctx, change) {
    var options = storeOptions(ctx);
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var read = readBoard(ctx);
        var board = read.board;
        board.bosses = board.bosses || {};
        for (var i = 0; i < KINDS.length; i++) {
            if (board.bosses[KINDS[i]] === undefined) {
                board.bosses[KINDS[i]] = null;
            }
        }
        var next = change(board);
        next.currency = currencySymbol(ctx);
        next.updatedAt = Date.now();
        if (ctx.storage.compareAndSet("board", read.raw, JSON.stringify(next), options).swapped) {
            return next;
        }
    }
    throw new Error("the Hype Board kept changing underneath this update; try again.");
}

function updateNumber(ctx, key, amount) {
    var options = storeOptions(ctx);
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var raw = ctx.storage.get(key);
        var current = Number(parseJson(raw)) || 0;
        var next = current + amount;
        if (ctx.storage.compareAndSet(key, raw === undefined ? null : raw, JSON.stringify(next), options).swapped) {
            return next;
        }
    }
    throw new Error(key + " kept changing underneath this update; try again.");
}

// By default the engine clears the board when the stream session ends; with
// "Keep totals between streams" it stays until !resetboard.
function storeOptions(ctx) {
    return toggle(ctx, "keepTotals", false) ? {} : { clearOnSessionEnd: true };
}

function tipsUnits(board) {
    return (Number(board.tipsCents) || 0) / 100;
}

// ---------------------------------------------------------------------------
// Subathon timer
// ---------------------------------------------------------------------------

function idleTimer() {
    return { status: "idle", endsAt: 0, remainingMs: 0, pausedBy: "", updatedAt: Date.now() };
}

function readTimer(ctx) {
    var raw = ctx.storage.get("subathon");
    var t = parseJson(raw);
    if (!t || typeof t !== "object" || !t.status) {
        return { raw: raw === undefined ? null : raw, timer: idleTimer() };
    }
    return { raw: raw, timer: t };
}

function currentTimer(ctx) {
    return readTimer(ctx).timer;
}

function writeTimer(ctx, t) {
    t.updatedAt = Date.now();
    ctx.storage.set("subathon", JSON.stringify(t));
    return t;
}

// Read-modify-write the timer. `change(timer, now)` returns the new timer, or
// null to leave it as it is; either way the timer as it now stands comes back.
function updateTimer(ctx, change) {
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var read = readTimer(ctx);
        var now = Date.now();
        var next = change(JSON.parse(JSON.stringify(read.timer)), now);
        if (!next) {
            return read.timer;
        }
        next.updatedAt = now;
        if (ctx.storage.compareAndSet("subathon", read.raw, JSON.stringify(next)).swapped) {
            return next;
        }
    }
    throw new Error("the subathon timer kept changing underneath this update; try again.");
}

function startTimer(ctx, lengthMs) {
    var length = Math.min(lengthMs, maxRemainingMs(ctx));
    return updateTimer(ctx, function (_, now) {
        return { status: "running", endsAt: now + length, remainingMs: length, pausedBy: "" };
    });
}

// Moves a running or paused timer by `deltaMs`, capped at the most time the
// timer may hold. A timer that already ran out is over, so support after the
// end adds nothing; a moderator can still `add` to bring it back.
function addTime(ctx, deltaMs, revive) {
    var cap = maxRemainingMs(ctx);
    return updateTimer(ctx, function (t, now) {
        if (t.status === "idle") {
            return null;
        }
        var left = remainingMs(t, now);
        if (left <= 0 && !revive) {
            return null;
        }
        var next = Math.max(0, Math.min(cap, left + deltaMs));
        if (next === left) {
            return null;
        }
        t.remainingMs = next;
        if (t.status === "running") {
            t.endsAt = now + next;
        }
        return t;
    });
}

function addEarnedTime(ctx, seconds) {
    if (!(seconds > 0)) {
        return;
    }
    addTime(ctx, Math.round(seconds * 1000), false);
}

function paused(t, now, by) {
    t.remainingMs = remainingMs(t, now);
    t.status = "paused";
    t.pausedBy = by;
    return t;
}

function resumed(t, now) {
    t.status = "running";
    t.endsAt = now + t.remainingMs;
    t.pausedBy = "";
    return t;
}

function remainingMs(t, now) {
    if (t.status === "running") {
        return Math.max(0, Number(t.endsAt) - now);
    }
    if (t.status === "paused") {
        return Math.max(0, Number(t.remainingMs) || 0);
    }
    return 0;
}

function timerStatusLine(t, now) {
    if (t.status === "idle") {
        return "There's no subathon running right now.";
    }
    var left = remainingMs(t, now);
    if (left <= 0) {
        return "The subathon timer has run out!";
    }
    return formatDuration(left) + " left on the subathon timer" + (t.status === "paused" ? " (paused)." : ".");
}

function timerResult(t) {
    return { remainingMs: remainingMs(t, Date.now()), status: t.status };
}

function startLengthMs(ctx) {
    return setting(ctx, "timerStartMinutes", DEFAULT_START_MINUTES) * 60000;
}

function maxRemainingMs(ctx) {
    var hours = setting(ctx, "timerMaxHours", 0);
    return hours > 0 ? hours * 3600000 : Number.MAX_SAFE_INTEGER;
}

function tierMultiplier(tier) {
    return TIER_MULTIPLIER[str(tier)] || 1;
}

// "4h", "90m", "1h30m", "45s", or a bare number of minutes.
function parseDuration(text) {
    var s = str(text).trim().toLowerCase();
    if (/^\d+(\.\d+)?$/.test(s)) {
        return Math.round(Number(s) * 60000);
    }
    var re = /(\d+(?:\.\d+)?)\s*(h|m|s)/g;
    var total = 0;
    var consumed = 0;
    var match;
    while ((match = re.exec(s)) !== null) {
        var n = Number(match[1]);
        total += match[2] === "h" ? n * 3600000 : match[2] === "m" ? n * 60000 : n * 1000;
        consumed += match[0].length;
    }
    return consumed === s.replace(/\s+/g, "").length && consumed > 0 ? Math.round(total) : null;
}

// H:MM:SS with hours unbounded, so a long subathon reads 214:39:09.
function formatDuration(ms) {
    var total = Math.ceil(ms / 1000);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    return hours + ":" + pad(minutes) + ":" + pad(seconds);
}

function pad(n) {
    return n < 10 ? "0" + n : String(n);
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function supporter(name) {
    var display = str(name).trim();
    if (!display) {
        return { key: "anonymous", name: "Anonymous" };
    }
    return { key: display.toLowerCase(), name: display };
}

function eventData(ctx) {
    return (ctx.event && ctx.event.data) || {};
}

function eventParams(ctx) {
    return (ctx.event && ctx.event.parameters) || {};
}

function moduleSettings(ctx) {
    return (ctx.module && ctx.module.settings) || {};
}

function setting(ctx, id, fallback) {
    var n = Number(moduleSettings(ctx)[id]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function toggle(ctx, id, fallback) {
    var v = moduleSettings(ctx)[id];
    if (v === undefined || v === null || v === "") {
        return fallback;
    }
    return v === true || v === "true";
}

function currencySymbol(ctx) {
    var s = moduleSettings(ctx).currencySymbol;
    return typeof s === "string" ? s : "$";
}

function say(ctx, text) {
    if (!ctx.chat || typeof ctx.chat.sendMessage !== "function") {
        throw new Error("ctx.chat.sendMessage is not available on this engine.");
    }
    ctx.chat.sendMessage(text);
}

function wholeNumber(value) {
    var n = Math.trunc(Number(value));
    return Number.isFinite(n) ? n : 0;
}

function firstDefined() {
    for (var i = 0; i < arguments.length; i++) {
        if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== "") {
            return arguments[i];
        }
    }
    return undefined;
}

function parseJson(raw) {
    if (raw === undefined || raw === null) {
        return null;
    }
    if (typeof raw !== "string") {
        return raw;
    }
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function str(value) {
    return value === undefined || value === null ? "" : String(value);
}
