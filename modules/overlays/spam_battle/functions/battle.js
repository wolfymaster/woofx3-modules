/// <reference types="@woofx3/module-sdk/function-ctx" />

// Spam Battle: while a battle is on, every chat message is read for the
// streamer it names, and that channel gets a vote. When the battle's timer
// runs out the leader is crowned, the module's `spam_battle.ended` trigger
// fires, and a little later the winner's Twitch channel is loaded in a browser
// source on the live OBS scene. The widget only reads storage; everything it
// shows is written here, except the clock, which it reads from the timer.
//
// Storage layout. Values are JSON *strings* this file serialises itself,
// because compareAndSet compares the stored bytes: handing back the exact
// string that was read is what makes the comparison reliable.
//
//   battle          {"round","phase":"idle"|"live"|"done","callout","prize",
//                    "lengthMs","startedAt","endedAt","total",
//                    "contenders":[{"login","name","avatar","votes","firstAt"}],
//                    "winner": {"login","name","avatar","votes","percent"} | null}
//                   contenders are kept sorted, most votes first, ties going
//                   to whoever was voted for first.
//   channel:<word>  {"ok":true,"login","name","avatar"} | {"ok":false}:
//                   what a word chat typed turned out to be on Twitch, so each
//                   word is looked up once.
//
// Every chat line is a write to `battle`, and a spamming chat makes many at
// once, so a vote that loses the compare-and-set race too often is dropped
// rather than failing the run: one vote out of a flood isn't worth an error.
//
// The timer is the one the `timer` setting links. Its time lives with the
// timer, and everything here changes it through ctx.resources.run. The battle
// follows the timer however it was driven (sync_timer runs on its started and
// ended events), so starting the timer from the dashboard starts a battle too.

var CAS_ATTEMPTS = 12;
// Enough for any real battle; past it, a new name with one vote can't matter.
var MAX_CONTENDERS = 100;
// A message is checked against Twitch for at most this many of its words.
var MAX_LOOKUPS_PER_MESSAGE = 2;
var DEFAULT_OBS_SOURCE = "Spam Battle Winner";
var DEFAULT_OBS_DELAY_SECONDS = 8;
var EVENT_STARTED = "spam_battle.started";
var EVENT_ENDED = "spam_battle.ended";
var SESSION = { clearOnSessionEnd: true };

// Chat words that are also somebody's Twitch login, skipped before asking
// Twitch so a "lol" flood doesn't spend lookups. Partners-only catches most of
// the rest; this list is about not asking.
var COMMON_WORDS = [
    "the", "and", "you", "for", "this", "that", "with", "what", "who", "him", "her", "his",
    "she", "they", "them", "are", "was", "not", "but", "all", "can", "get", "got", "yes",
    "yep", "nope", "lol", "lmao", "lmfao", "rofl", "omg", "wtf", "idk", "imo", "pls",
    "plz", "too", "now", "one", "two", "best", "goat", "king", "queen", "win", "wins",
    "gg", "ggs", "hype", "lets", "let", "go", "gooo", "letsgo", "pog", "poggers",
    "pogchamp", "kekw", "lul", "lulw", "omegalul", "kappa", "monkas", "pepega", "sadge",
    "copium", "ez", "clap", "spam", "vote", "chat", "stream", "streamer", "favorite",
    "favourite", "love", "hello", "hey", "bye", "wow", "nice", "good", "bad"
];

// ---------------------------------------------------------------------------
// Chat (run on every chat message)
// ---------------------------------------------------------------------------

function handle_chat_message(ctx) {
    var data = eventData(ctx);
    var message = str(data.message).trim();
    var words = message.split(/\s+/);
    var membership = data.membership || {};

    if (words[0].toLowerCase() === "!spambattle") {
        var isMod = membership.isModerator === true || membership.isBroadcaster === true;
        return handleCommand(ctx, words, isMod);
    }

    var chatter = str(data.chatterName).toLowerCase();
    if (chatter !== "" && ignoredNames(ctx).indexOf(chatter) !== -1) {
        return { command: "", counted: "" };
    }
    if (readBattle(ctx).battle.phase !== "live") {
        return { command: "", counted: "" };
    }

    var channel = pickChannel(ctx, message);
    if (!channel) {
        return { command: "", counted: "" };
    }
    return { command: "", counted: castVote(ctx, channel) ? channel.login : "" };
}

function handleCommand(ctx, words, isMod) {
    var sub = (words[1] || "").toLowerCase();
    if (!isMod || sub === "") {
        say(ctx, statusLine(ctx));
        return { command: "spambattle", counted: "" };
    }
    switch (sub) {
        case "start": {
            var length = words[2] ? parseDuration(words[2]) : null;
            if (words[2] && (length === null || length < 5000)) {
                say(ctx, "Try !spambattle start 2m, 90s or 1m30s.");
                return { command: "spambattle start", counted: "" };
            }
            return respond(ctx, startBattle(ctx, length), { command: "spambattle start", counted: "" });
        }
        case "end":
        case "stop":
            return respond(ctx, finishNow(ctx), { command: "spambattle end", counted: "" });
        case "cancel":
            cancelBattle(ctx);
            say(ctx, "The Spam Battle was called off. No winner this time.");
            return { command: "spambattle cancel", counted: "" };
        default:
            say(ctx, "Spam Battle commands: start, end, cancel.");
            return { command: "spambattle", counted: "" };
    }
}

// ---------------------------------------------------------------------------
// Action entry points (for workflows, buttons and stream decks)
// ---------------------------------------------------------------------------

function start_battle(ctx) {
    var seconds = Number(eventParams(ctx).seconds);
    var length = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
    return respond(ctx, startBattle(ctx, length));
}

function end_battle(ctx) {
    return respond(ctx, finishNow(ctx));
}

function cancel_battle(ctx) {
    cancelBattle(ctx);
    return { ok: true };
}

/**
 * timer.started / timer.ended, for any timer. A start that didn't come from
 * here (the dashboard, a workflow) opens a fresh battle; a start from here
 * finds the battle already live and leaves it, as does a resume after a pause.
 */
function sync_timer(ctx) {
    var data = eventData(ctx);
    var timer = linkedTimer(ctx);
    if (!timer || data.target !== timer) {
        return { followed: false };
    }
    var type = str(ctx.event && ctx.event.type);
    if (type === "timer.started") {
        if (readBattle(ctx).battle.phase === "live") {
            return { followed: true };
        }
        var remaining = Number(data.remaining);
        return respond(ctx, openBattle(ctx, Number.isFinite(remaining) ? remaining * 1000 : 0), { followed: true });
    }
    if (type === "timer.ended") {
        return respond(ctx, finishBattle(ctx), { followed: true });
    }
    return { followed: true };
}

/**
 * Loads the winner's channel in OBS. Run by the show_winner deadline once the
 * celebration has played, and by hand from the action. A deadline can fire
 * late or twice, so it only acts while the battle it was armed for is still
 * the one on screen.
 */
function show_winner_in_obs(ctx) {
    var battle = readBattle(ctx).battle;
    var params = eventParams(ctx);
    var fromDeadline = !!(ctx.event && ctx.event.deadline);
    if (fromDeadline && str(params.round) !== battle.round) {
        return { url: "", skipped: "a newer battle started" };
    }
    if (battle.phase !== "done" || !battle.winner) {
        return { url: "", skipped: "no winner to show" };
    }
    if (!ctx.obs || typeof ctx.obs.showBrowserSource !== "function") {
        throw new Error("ctx.obs.showBrowserSource is not available on this engine; update WoofX3 to show the winner in OBS.");
    }
    var url = channelUrl(battle.winner.login);
    ctx.obs.showBrowserSource({ sourceName: obsSourceName(ctx), url: url });
    return { url: url };
}

// ---------------------------------------------------------------------------
// Battle lifecycle
// ---------------------------------------------------------------------------

function emptyBattle() {
    return {
        round: "",
        phase: "idle",
        callout: "",
        prize: "",
        lengthMs: 0,
        startedAt: 0,
        endedAt: 0,
        total: 0,
        contenders: [],
        winner: null
    };
}

function readBattle(ctx) {
    var raw = ctx.storage.get("battle");
    var battle = parseJson(raw);
    if (!battle || typeof battle !== "object") {
        battle = emptyBattle();
    }
    if (!Array.isArray(battle.contenders)) {
        battle.contenders = [];
    }
    return { raw: raw === undefined ? null : raw, battle: battle };
}

// Read-modify-write the battle. `change(battle)` returns the new battle, or
// null to leave it. Returns { battle, wrote }, or null when the race was lost
// every time.
function updateBattle(ctx, change) {
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var read = readBattle(ctx);
        var next = change(read.battle);
        if (!next) {
            return { battle: read.battle, wrote: false };
        }
        if (ctx.storage.compareAndSet("battle", read.raw, JSON.stringify(next), SESSION).swapped) {
            return { battle: next, wrote: true };
        }
    }
    return null;
}

// Starts a battle from `lengthMs`, or from the timer's own length when null,
// replacing one already running.
function startBattle(ctx, lengthMs) {
    var timer = requireTimer(ctx);
    // Opened first, so the timer.started this causes finds it already live.
    // The timer's own length is only known once it's running, so a battle on
    // it opens without one and has it filled in below.
    var opened = openBattle(ctx, lengthMs || 0);
    if (lengthMs === null) {
        runTimer(ctx, timer, "reset");
    } else {
        runTimer(ctx, timer, "set", { seconds: Math.round(lengthMs / 1000) });
    }
    var now = runTimer(ctx, timer, "start");
    if (lengthMs === null) {
        updateBattle(ctx, function (b) {
            if (b.round !== opened.value.round) {
                return null;
            }
            b.lengthMs = now.remaining * 1000;
            return b;
        });
        opened.events[0].data.seconds = now.remaining;
    }
    opened.value.remaining = now.remaining;
    return opened;
}

// Writes a fresh live battle and tells chat. Like every lifecycle step here,
// returns { value, events } for an entry point to hand to respond().
function openBattle(ctx, lengthMs) {
    ctx.schedule.cancel("show_winner", "winner");
    var fresh = emptyBattle();
    fresh.round = String(Date.now()) + Math.floor(Math.random() * 1e6);
    fresh.phase = "live";
    fresh.callout = callout(ctx);
    fresh.prize = prize(ctx);
    fresh.lengthMs = Math.max(0, Math.round(lengthMs));
    fresh.startedAt = Date.now();
    ctx.storage.set("battle", JSON.stringify(fresh), SESSION);

    if (fresh.callout) {
        say(ctx, fresh.callout);
    }
    if (fresh.prize) {
        say(ctx, fresh.prize);
    }
    return {
        value: { round: fresh.round },
        events: [{ type: EVENT_STARTED, data: { seconds: Math.round(fresh.lengthMs / 1000), prize: fresh.prize } }]
    };
}

// Ends a live battle: crowns the leader, tells chat, fires the ended trigger
// and arms the OBS reveal. A battle that already ended is left alone, so the
// timer.ended that follows a moderator's !spambattle end does nothing.
function finishBattle(ctx) {
    var outcome = updateBattle(ctx, function (b) {
        if (b.phase !== "live") {
            return null;
        }
        b.phase = "done";
        b.endedAt = Date.now();
        var top = b.contenders[0];
        b.winner = top && top.votes > 0
            ? { login: top.login, name: top.name, avatar: top.avatar, votes: top.votes, percent: percentOf(top.votes, b.total) }
            : null;
        return b;
    });
    if (!outcome) {
        throw new Error("the battle kept changing underneath this update; try again.");
    }
    if (!outcome.wrote) {
        return { value: { winnerLogin: "", ended: false }, events: [] };
    }

    var battle = outcome.battle;
    var w = battle.winner;
    if (w) {
        say(ctx, "Time's up! " + w.name + " wins the Spam Battle with " + w.percent + "% of the vote! " + channelUrl(w.login));
        if (toggle(ctx, "showInObs", true)) {
            var delay = setting(ctx, "obsDelaySeconds", DEFAULT_OBS_DELAY_SECONDS);
            ctx.schedule.at("show_winner", "winner", Date.now() + delay * 1000, { round: battle.round });
        }
    } else {
        say(ctx, "Time's up! Nobody spammed a streamer this time.");
    }
    return {
        value: { winnerLogin: w ? w.login : "", ended: true },
        events: [{
            type: EVENT_ENDED,
            data: {
                hasWinner: !!w,
                winnerLogin: w ? w.login : "",
                winnerName: w ? w.name : "",
                winnerUrl: w ? channelUrl(w.login) : "",
                votes: w ? w.votes : 0,
                percent: w ? w.percent : 0,
                totalVotes: battle.total,
                prize: battle.prize
            }
        }]
    };
}

// A moderator or workflow ending the battle early: crown first, then stop the
// clock, so the timer's own end finds nothing left to do.
function finishNow(ctx) {
    var timer = linkedTimer(ctx);
    var finished = finishBattle(ctx);
    if (!finished.value.ended) {
        say(ctx, "There's no Spam Battle running. Start one with !spambattle start.");
    }
    if (timer) {
        runTimer(ctx, timer, "pause");
        runTimer(ctx, timer, "set", { seconds: 0 });
    }
    return finished;
}

function cancelBattle(ctx) {
    ctx.schedule.cancel("show_winner", "winner");
    updateBattle(ctx, function (b) {
        if (b.phase === "idle") {
            return null;
        }
        b.phase = "idle";
        b.winner = null;
        return b;
    });
    var timer = linkedTimer(ctx);
    if (timer) {
        runTimer(ctx, timer, "pause");
        runTimer(ctx, timer, "set", { seconds: 0 });
    }
}

function statusLine(ctx) {
    var battle = readBattle(ctx).battle;
    if (battle.phase === "done" && battle.winner) {
        return "The last Spam Battle went to " + battle.winner.name + " with " + battle.winner.percent + "% of the vote!";
    }
    if (battle.phase !== "live") {
        return "No Spam Battle right now. Stay tuned!";
    }
    var top = battle.contenders.slice(0, 3).map(function (c) {
        return c.name + " " + percentOf(c.votes, battle.total) + "%";
    });
    return (battle.callout || "Spam your favorite streamer in chat!") +
        (top.length ? " Leading: " + top.join(", ") + "." : "");
}

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

// Adds one vote for `channel`. Returns whether it landed.
function castVote(ctx, channel) {
    var outcome = updateBattle(ctx, function (b) {
        if (b.phase !== "live") {
            return null;
        }
        var i = indexOfLogin(b.contenders, channel.login);
        if (i === -1) {
            if (b.contenders.length >= MAX_CONTENDERS) {
                return null;
            }
            b.contenders.push({ login: channel.login, name: channel.name, avatar: channel.avatar, votes: 0, firstAt: Date.now() });
            i = b.contenders.length - 1;
        }
        b.contenders[i].votes += 1;
        b.total = (Number(b.total) || 0) + 1;
        b.contenders.sort(function (x, y) {
            return y.votes - x.votes || x.firstAt - y.firstAt;
        });
        return b;
    });
    return !!(outcome && outcome.wrote);
}

// The channel a message names, or null. Words are tried most-likely first: an
// @mention or twitch.tv link, then whatever word the message repeats most
// (spam is "xqc xqc xqc"), then in the order typed.
function pickChannel(ctx, message) {
    var ignored = ignoredNames(ctx);
    var lookups = 0;
    var words = candidateWords(message);
    for (var i = 0; i < words.length; i++) {
        if (ignored.indexOf(words[i]) !== -1) {
            continue;
        }
        var cached = parseJson(ctx.storage.get("channel:" + words[i]));
        if (cached && typeof cached === "object") {
            if (cached.ok) {
                return cached;
            }
            continue;
        }
        if (lookups >= MAX_LOOKUPS_PER_MESSAGE) {
            break;
        }
        lookups++;
        var found = lookUp(ctx, words[i]);
        if (found && found.ok) {
            return found;
        }
    }
    return null;
}

function candidateWords(message) {
    var seen = {};
    var order = [];
    message.split(/\s+/).forEach(function (raw, index) {
        var link = /twitch\.tv\/([A-Za-z0-9_]+)/i.exec(raw);
        var mention = !!link || raw.charAt(0) === "@";
        var word = (link ? link[1] : raw.replace(/^@+/, ""))
            .replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, "")
            .toLowerCase();
        if (!/^[a-z0-9_]{3,25}$/.test(word)) {
            return;
        }
        if (!mention && COMMON_WORDS.indexOf(word) !== -1) {
            return;
        }
        if (!seen[word]) {
            seen[word] = { word: word, count: 0, mention: false, index: index };
            order.push(seen[word]);
        }
        seen[word].count++;
        seen[word].mention = seen[word].mention || mention;
    });
    order.sort(function (a, b) {
        return (b.mention - a.mention) || (b.count - a.count) || (a.index - b.index);
    });
    return order.map(function (c) { return c.word; });
}

// Asks Twitch whether `word` is a channel that can be voted for, and remembers
// the answer. A Twitch that can't be reached right now isn't remembered, so
// the word is asked about again on its next mention.
function lookUp(ctx, word) {
    if (!ctx.twitch || typeof ctx.twitch.getUser !== "function") {
        return null;
    }
    var user;
    try {
        user = ctx.twitch.getUser({ userName: word });
    } catch (err) {
        if (err && err.code) {
            // timeout, unavailable, call_limit, busy: not an answer about the word.
            return null;
        }
        user = null;
    }
    var answer;
    if (!user || !user.login) {
        answer = { ok: false };
    } else if (toggle(ctx, "streamersOnly", true) && !user.broadcasterType) {
        answer = { ok: false };
    } else {
        answer = {
            ok: true,
            login: str(user.login).toLowerCase(),
            name: str(user.displayName) || str(user.login),
            avatar: str(user.profileImageUrl)
        };
    }
    ctx.storage.set("channel:" + word, JSON.stringify(answer), SESSION);
    return answer;
}

function indexOfLogin(list, login) {
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].login === login) {
            return i;
        }
    }
    return -1;
}

function percentOf(votes, total) {
    return total > 0 ? Math.round((votes / total) * 100) : 0;
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

// The canonical id the `timer` setting links, or null when none is picked.
function linkedTimer(ctx) {
    var id = str(moduleSettings(ctx).timer).trim();
    return id === "" ? null : id;
}

function requireTimer(ctx) {
    var timer = linkedTimer(ctx);
    if (!timer) {
        throw new Error("spam battle: no battle timer is picked in the module settings");
    }
    return timer;
}

// Runs one of the timer's own actions: get, start, pause, reset, add, set.
// Each answers { running, remaining (seconds), endsAt, ... }.
function runTimer(ctx, timer, verb, params) {
    return ctx.resources.run(timer, verb, params || {});
}

// "2m", "90s", "1m30s", or a bare number of seconds.
function parseDuration(text) {
    var s = str(text).trim().toLowerCase();
    if (/^\d+(\.\d+)?$/.test(s)) {
        return Math.round(Number(s) * 1000);
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

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

// The run's result: `extra` merged over a lifecycle step's value, with its
// events published alongside when there are any.
function respond(ctx, outcome, extra) {
    var value = {};
    [outcome.value, extra].forEach(function (o) {
        Object.keys(o || {}).forEach(function (k) { value[k] = o[k]; });
    });
    return outcome.events.length ? ctx.result(value, outcome.events) : value;
}

function channelUrl(login) {
    return "https://www.twitch.tv/" + encodeURIComponent(login);
}

function callout(ctx) {
    var s = moduleSettings(ctx).callout;
    return typeof s === "string" ? s.trim() : "Spam your favorite streamer in chat!";
}

function prize(ctx) {
    var s = moduleSettings(ctx).prize;
    return typeof s === "string" ? s.trim() : "5 subs to the winner!";
}

function obsSourceName(ctx) {
    var s = str(moduleSettings(ctx).obsSourceName).trim();
    return s || DEFAULT_OBS_SOURCE;
}

// The "Names that can't be voted for" setting: names separated by commas or spaces.
function ignoredNames(ctx) {
    return str(moduleSettings(ctx).ignoredNames)
        .toLowerCase()
        .split(/[\s,]+/)
        .map(function (n) { return n.replace(/^@/, ""); })
        .filter(function (n) { return n !== ""; });
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

function say(ctx, text) {
    if (!ctx.chat || typeof ctx.chat.sendMessage !== "function") {
        throw new Error("ctx.chat.sendMessage is not available on this engine.");
    }
    ctx.chat.sendMessage(text);
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
