/// <reference types="@woofx3/module-sdk/function-ctx" />

// Hype Board: counts bits, subs and tips, crowns the biggest supporter of
// each, and runs a subathon on a WoofX3 timer those events add time to. The
// board widget only reads storage; everything it shows is written here, except
// the timer, which the widget reads from the timer itself.
//
// Storage layout. Values are JSON *strings* this file serialises itself,
// because compareAndSet compares the stored bytes: handing back the exact
// string that was read is what makes the comparison reliable.
//
//   board     {"round","currency","subs","bits","tipsCents",
//              "bosses":{"bits"|"gifts"|"tips": {"key","name","amount"} | null},
//              "updatedAt"}
//   fan:<round>:<kind>:<name key>   a supporter's running total for one kind
//   subathon  {"active","ended","pausedBy"}
//
// Why `round` is in each fan key: storage can't be listed or deleted from a
// sandbox, so a reset can't clear every supporter's tally. Starting a new
// round instead makes the old tallies unreachable. By default everything is
// written clearOnSessionEnd, and the engine clears it all; with "Keep totals
// between streams" the orphaned tallies are a few bytes per supporter, left
// behind only when the streamer resets.
//
// The timer is the one the `timer` setting links: install makes one and links
// it, and the streamer can pick another. Its time lives with the timer, and
// everything here changes it through ctx.resources.run, the same actions a
// workflow uses. What the timer cannot say is whether a subathon is on — a
// stopped timer at its full length is both "not started" and "paused" — so
// `subathon` records that, and who paused it: a pause the stream going offline
// caused is undone when it comes back, one a moderator made is not. It is kept
// in step with changes made elsewhere (the dashboard, a workflow) by
// sync_timer, which the timer's started, paused and ended events run.
//
// The subathon is never cleared with the session: a subathon commonly spans
// several streams, and pausing while offline is what carries it over.

var CAS_ATTEMPTS = 8;
var KINDS = ["bits", "gifts", "tips"];
var TIER_MULTIPLIER = { "1000": 1, "2000": 2, "3000": 5 };
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
    var timer = linkedTimer(ctx);
    if (!timer || !toggle(ctx, "pauseWhenOffline", true)) {
        return { live: live };
    }
    var sub = readSubathon(ctx).state;
    if (!sub.active) {
        return { live: live };
    }
    if (live) {
        // Only undo a pause the stream ending caused: a timer a moderator
        // paused stays paused until they resume it.
        if (sub.pausedBy === "offline") {
            resumeTimer(ctx, timer);
        }
    } else if (sub.pausedBy === "" && runTimer(ctx, timer, "get").running) {
        pauseTimer(ctx, timer, "offline");
    }
    return { live: live };
}

/**
 * timer.started / timer.paused / timer.ended, for any timer. Follows the
 * subathon timer's changes however they were made, so a start or pause from
 * the dashboard or a workflow counts the same as one from chat.
 */
function sync_timer(ctx) {
    var data = eventData(ctx);
    var timer = linkedTimer(ctx);
    if (!timer || data.target !== timer) {
        return { followed: false };
    }
    var type = str(ctx.event && ctx.event.type);
    updateSubathon(ctx, function (sub) {
        if (type === "timer.started") {
            return { active: true, ended: false, pausedBy: "" };
        }
        if (type === "timer.ended") {
            return { active: false, ended: true, pausedBy: "" };
        }
        if (type === "timer.paused" && sub.active && sub.pausedBy === "") {
            // Paused somewhere other than here: leave it for whoever did it.
            return { active: true, ended: false, pausedBy: "elsewhere" };
        }
        return null;
    });
    return { followed: true };
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

    var timer = linkedTimer(ctx);
    if (!timer) {
        say(ctx, "The Hype Board has no subathon timer picked yet.");
        return { command: "subathon" };
    }

    if (sub === "" || !isMod) {
        say(ctx, timerStatusLine(ctx, timer));
        return { command: "subathon" };
    }

    switch (sub) {
        case "start": {
            var length = words[2] ? parseDuration(words[2]) : null;
            if (words[2] && (length === null || length <= 0)) {
                say(ctx, "Try !subathon start 4h, 90m or 1h30m.");
                return { command: "subathon start" };
            }
            var started = startSubathon(ctx, timer, length);
            say(ctx, "The subathon is on! " + formatDuration(started.remaining * 1000) + " on the clock.");
            return { command: "subathon start" };
        }
        case "pause":
            if (readSubathon(ctx).state.active && runTimer(ctx, timer, "get").running) {
                var held = pauseTimer(ctx, timer, "mod");
                say(ctx, "Subathon timer paused at " + formatDuration(held.remaining * 1000) + ".");
            } else {
                say(ctx, timerStatusLine(ctx, timer));
            }
            return { command: "subathon pause" };
        case "resume":
            if (readSubathon(ctx).state.active && runTimer(ctx, timer, "get").remaining > 0) {
                resumeTimer(ctx, timer);
            }
            say(ctx, timerStatusLine(ctx, timer));
            return { command: "subathon resume" };
        case "add":
        case "remove": {
            var amount = words[2] ? parseDuration(words[2]) : null;
            if (amount === null || amount <= 0) {
                say(ctx, "Try !subathon " + sub + " 10m.");
                return { command: "subathon " + sub };
            }
            if (!moderatorAddTime(ctx, timer, sub === "add" ? amount : -amount)) {
                say(ctx, "There's no subathon running. Start one with !subathon start.");
                return { command: "subathon " + sub };
            }
            say(ctx, (sub === "add" ? "Added " : "Took away ") + formatDuration(amount) + ". " + timerStatusLine(ctx, timer));
            return { command: "subathon " + sub };
        }
        case "end":
        case "stop":
            endSubathon(ctx, timer);
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
    var length = Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : null;
    return startSubathon(ctx, requireTimer(ctx), length);
}

function pause_timer(ctx) {
    var timer = requireTimer(ctx);
    if (!readSubathon(ctx).state.active || !runTimer(ctx, timer, "get").running) {
        return runTimer(ctx, timer, "get");
    }
    return pauseTimer(ctx, timer, "mod");
}

function resume_timer(ctx) {
    var timer = requireTimer(ctx);
    if (!readSubathon(ctx).state.active || runTimer(ctx, timer, "get").remaining <= 0) {
        return runTimer(ctx, timer, "get");
    }
    return resumeTimer(ctx, timer);
}

function add_time(ctx) {
    var timer = requireTimer(ctx);
    var minutes = Number(eventParams(ctx).minutes);
    if (Number.isFinite(minutes) && minutes !== 0) {
        moderatorAddTime(ctx, timer, minutes * 60000);
    }
    return runTimer(ctx, timer, "get");
}

function end_timer(ctx) {
    return endSubathon(ctx, requireTimer(ctx));
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

// The canonical id the `timer` setting links, or null when none is picked.
function linkedTimer(ctx) {
    var id = str(moduleSettings(ctx).timer).trim();
    return id === "" ? null : id;
}

function requireTimer(ctx) {
    var timer = linkedTimer(ctx);
    if (!timer) {
        throw new Error("hype board: no subathon timer is picked in the module settings");
    }
    return timer;
}

// Runs one of the timer's own actions: get, start, pause, reset, add, set.
// Each answers { running, remaining (seconds), endsAt, ... }.
function runTimer(ctx, timer, verb, params) {
    return ctx.resources.run(timer, verb, params || {});
}

function readSubathon(ctx) {
    var raw = ctx.storage.get("subathon");
    var state = parseJson(raw);
    if (!state || typeof state !== "object") {
        state = { active: false, ended: false, pausedBy: "" };
    }
    state.active = state.active === true;
    state.ended = state.ended === true;
    state.pausedBy = str(state.pausedBy);
    return { raw: raw === undefined ? null : raw, state: state };
}

// Read-modify-write the subathon. `change(state)` returns the new state, or
// null to leave it as it is.
function updateSubathon(ctx, change) {
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var read = readSubathon(ctx);
        var next = change(read.state);
        if (!next) {
            return read.state;
        }
        if (ctx.storage.compareAndSet("subathon", read.raw, JSON.stringify(next)).swapped) {
            return next;
        }
    }
    throw new Error("the subathon kept changing underneath this update; try again.");
}

function setSubathon(ctx, state) {
    updateSubathon(ctx, function () {
        return state;
    });
}

// Starts a subathon from `lengthMs`, or from the timer's own length when
// null, replacing one already running.
function startSubathon(ctx, timer, lengthMs) {
    // Recorded first, so the timer.started this causes finds it already on.
    setSubathon(ctx, { active: true, ended: false, pausedBy: "" });
    if (lengthMs === null) {
        runTimer(ctx, timer, "reset");
    } else {
        runTimer(ctx, timer, "set", { seconds: Math.round(Math.min(lengthMs, maxSecondsLeft(ctx) * 1000) / 1000) });
    }
    return runTimer(ctx, timer, "start");
}

// Who paused it is recorded before the pause, so the timer.paused this
// causes does not read as a pause from somewhere else.
function pauseTimer(ctx, timer, by) {
    setSubathon(ctx, { active: true, ended: false, pausedBy: by });
    return runTimer(ctx, timer, "pause");
}

function resumeTimer(ctx, timer) {
    setSubathon(ctx, { active: true, ended: false, pausedBy: "" });
    return runTimer(ctx, timer, "start");
}

// Stops the timer at zero and ends the subathon, so the board shows it over
// rather than paused.
function endSubathon(ctx, timer) {
    setSubathon(ctx, { active: false, ended: false, pausedBy: "" });
    runTimer(ctx, timer, "pause");
    return runTimer(ctx, timer, "set", { seconds: 0 });
}

// Time a moderator adds or takes away. A subathon that ran out comes back to
// life when time is added to it; one that never started is left alone.
// Returns false when there is no subathon to change.
function moderatorAddTime(ctx, timer, deltaMs) {
    var sub = readSubathon(ctx).state;
    if (!sub.active && !sub.ended) {
        return false;
    }
    var now = runTimer(ctx, timer, "get");
    var seconds = Math.round(deltaMs / 1000);
    if (seconds > 0) {
        seconds = Math.min(seconds, Math.max(0, maxSecondsLeft(ctx) - now.remaining));
    } else {
        seconds = Math.max(seconds, -now.remaining);
    }
    if (seconds !== 0) {
        runTimer(ctx, timer, "add", { seconds: seconds });
    }
    if (!sub.active && deltaMs > 0) {
        resumeTimer(ctx, timer);
    }
    return true;
}

// Time support earns. Added only while a subathon is on and the timer still
// has time: once it runs out the subathon is over, and support after the end
// adds nothing. A paused subathon still collects time.
function addEarnedTime(ctx, seconds) {
    if (!(seconds > 0)) {
        return;
    }
    var timer = linkedTimer(ctx);
    if (!timer || !readSubathon(ctx).state.active) {
        return;
    }
    var now = runTimer(ctx, timer, "get");
    if (now.remaining <= 0) {
        return;
    }
    var add = Math.min(Math.round(seconds), Math.max(0, maxSecondsLeft(ctx) - now.remaining));
    if (add > 0) {
        runTimer(ctx, timer, "add", { seconds: add });
    }
}

function timerStatusLine(ctx, timer) {
    var sub = readSubathon(ctx).state;
    if (!sub.active && !sub.ended) {
        return "There's no subathon running right now.";
    }
    var now = runTimer(ctx, timer, "get");
    if (now.remaining <= 0) {
        return "The subathon timer has run out!";
    }
    return formatDuration(now.remaining * 1000) + " left on the subathon timer" + (now.running ? "." : " (paused).");
}

// The most time the timer may hold, in seconds; unlimited when the setting is 0.
function maxSecondsLeft(ctx) {
    var hours = setting(ctx, "timerMaxHours", 0);
    return hours > 0 ? hours * 3600 : Number.MAX_SAFE_INTEGER;
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
