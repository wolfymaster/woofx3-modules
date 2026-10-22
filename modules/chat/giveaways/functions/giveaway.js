/// <reference types="@woofx3/module-sdk/function-ctx" />

// One giveaway at a time, held in a single storage key as a JSON string:
//
//   { open, keyword, prize, startedBy, entrants: [[key, name, id, weight]], winners: [key] }
//
// It is a string rather than an object because compareAndSet compares the
// stored encoding: a string round-trips byte for byte, where an object's key
// order is not something to bet a lost entry on. "" means no giveaway, since
// storage has no delete.
//
// Every entry point is also a workflow action. Nothing here writes to chat: a
// reply comes back as `message`. A chat-driven reply is also announced with a
// giveaways.announced event that the module's workflow posts with a Send chat
// message step, so ordinary chat (nothing to say) posts nothing and fails
// nothing. The start_giveaway, draw_winner and end_giveaway actions only return
// `message`; a workflow that calls them adds its own Send chat message step.

var STATE_KEY = "giveaway";
var MAX_ATTEMPTS = 8;
var DEFAULT_KEYWORD = "!join";
var DEFAULT_MAX_ENTRIES = 1000;
// Bounds the weight a hand-edited setting can give subscribers, so one typo
// can't make the draw a formality.
var MAX_SUBSCRIBER_LUCK = 10;

var EVENT_STARTED = "giveaways.started";
var EVENT_ENTERED = "giveaways.entered";
var EVENT_WINNER = "giveaways.winner";
var EVENT_ANNOUNCED = "giveaways.announced";

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function handle_chat_message(ctx) {
    var data = (ctx.event && ctx.event.data) || {};
    var message = cleanMessage(data.message);
    if (!message) {
        return { handled: "none" };
    }
    var words = message.split(/\s+/);
    var first = words[0].toLowerCase();

    if (first === "!giveaway") {
        var membership = data.membership || {};
        if (membership.isModerator !== true && membership.isBroadcaster !== true) {
            return { handled: "none", reason: "not a moderator" };
        }
        var sub = (words[1] || "").toLowerCase();
        var by = String(data.chatterName || "");
        switch (sub) {
            case "start":
            case "open":
                return startGiveaway(ctx, words[2] || "", "", by, true);
            case "draw":
            case "pick":
            case "roll":
                return drawWinner(ctx, true);
            case "end":
            case "close":
            case "stop":
                return endGiveaway(ctx, true);
            case "cancel":
            case "clear":
                return cancelGiveaway(ctx);
            default:
                return reportStatus(ctx);
        }
    }

    var state = parseState(ctx.storage.get(STATE_KEY));
    if (!state || !state.open || first !== state.keyword.toLowerCase()) {
        return { handled: "none" };
    }
    return enter(ctx, data);
}

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function start_giveaway(ctx) {
    var params = (ctx.event && ctx.event.parameters) || {};
    return startGiveaway(ctx, String(params.keyword || ""), String(params.prize || ""), "", false);
}

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function draw_winner(ctx) {
    return drawWinner(ctx, false);
}

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function end_giveaway(ctx) {
    return endGiveaway(ctx, false);
}

function startGiveaway(ctx, keyword, prize, startedBy, announce) {
    keyword = keyword.trim() || settingString(ctx, "defaultKeyword", DEFAULT_KEYWORD);
    prize = prize.trim();

    var outcome = update(ctx, function (state) {
        if (state && state.open) {
            return { result: state };
        }
        var fresh = { open: true, keyword: keyword, prize: prize, startedBy: startedBy, entrants: [], winners: [] };
        return { next: fresh, result: fresh };
    });

    if (!outcome.wrote) {
        return speak(
            ctx, announce,
            "A giveaway is already open! Type " + outcome.result.keyword + " to enter.",
            { handled: "started", started: false, keyword: outcome.result.keyword }
        );
    }

    return speak(
        ctx, announce,
        "Giveaway time" + (prize ? " for " + prize : "") + "! Type " + keyword + " in chat to enter.",
        { handled: "started", started: true, keyword: keyword },
        [{ type: EVENT_STARTED, data: { keyword: keyword, prize: prize, startedBy: startedBy } }]
    );
}

function enter(ctx, data) {
    var name = String(data.chatterName || "");
    var id = String(data.chatterId || "");
    var key = id || name.toLowerCase();
    if (!key) {
        return { handled: "none", reason: "no chatter" };
    }
    var membership = data.membership || {};
    var weight = membership.isSubscriber === true ? subscriberLuck(ctx) : 1;
    var maxEntries = settingNumber(ctx, "maxEntries", DEFAULT_MAX_ENTRIES, 1);

    var outcome = update(ctx, function (state) {
        if (!state || !state.open) {
            return { result: "closed" };
        }
        for (var i = 0; i < state.entrants.length; i++) {
            if (state.entrants[i][0] === key) {
                return { result: "duplicate" };
            }
        }
        if (state.entrants.length >= maxEntries) {
            return { result: "full" };
        }
        state.entrants.push([key, name, id, weight]);
        return { next: state, result: state.entrants.length };
    });

    // A repeat entry or a full giveaway gets no reply: answering every
    // "!join" spam would flood chat with the bot's own messages.
    if (!outcome.wrote) {
        return { handled: "none", reason: outcome.result };
    }

    var entryCount = outcome.result;
    var events = [{ type: EVENT_ENTERED, data: { userName: name, userId: id, entryCount: entryCount } }];
    if (settingBool(ctx, "announceEntries")) {
        return speak(ctx, true, "@" + name + " you're in! Good luck!", { handled: "entered", entryCount: entryCount }, events);
    }
    return ctx.result({ handled: "entered", entryCount: entryCount }, events);
}

function drawWinner(ctx, announce) {
    var outcome = update(ctx, function (state) {
        if (!state) {
            return { result: { reason: "none" } };
        }
        var winners = {};
        for (var w = 0; w < state.winners.length; w++) {
            winners[state.winners[w]] = true;
        }
        var pool = [];
        var total = 0;
        for (var i = 0; i < state.entrants.length; i++) {
            if (!winners[state.entrants[i][0]]) {
                pool.push(state.entrants[i]);
                total += state.entrants[i][3];
            }
        }
        if (pool.length === 0) {
            return { result: { reason: state.entrants.length === 0 ? "empty" : "exhausted" } };
        }
        var roll = Math.random() * total;
        var picked = pool[pool.length - 1];
        for (var p = 0; p < pool.length; p++) {
            roll -= pool[p][3];
            if (roll < 0) {
                picked = pool[p];
                break;
            }
        }
        // Drawing closes entries: nobody should be able to join after
        // seeing who won.
        state.open = false;
        state.winners.push(picked[0]);
        return { next: state, result: { entrant: picked, prize: state.prize, entryCount: state.entrants.length } };
    });

    if (!outcome.wrote) {
        var reason = outcome.result.reason;
        return speak(
            ctx, announce,
            reason === "none" ? "There's no giveaway to draw from. Start one with !giveaway start."
                : reason === "empty" ? "Nobody has entered the giveaway yet!"
                    : "Everyone who entered has already won!",
            { handled: "drawn", winnerName: "", winnerId: "", entryCount: 0 }
        );
    }

    var picked = outcome.result.entrant;
    var prize = outcome.result.prize;
    var entryCount = outcome.result.entryCount;
    return speak(
        ctx, announce,
        "Congratulations @" + picked[1] + ", you won" + (prize ? " " + prize : " the giveaway") + "!",
        { handled: "drawn", winnerName: picked[1], winnerId: picked[2], entryCount: entryCount },
        [{ type: EVENT_WINNER, data: { winnerName: picked[1], winnerId: picked[2], prize: prize, entryCount: entryCount } }]
    );
}

function endGiveaway(ctx, announce) {
    var outcome = update(ctx, function (state) {
        if (!state || !state.open) {
            return { result: state ? state.entrants.length : -1 };
        }
        state.open = false;
        return { next: state, result: state.entrants.length };
    });
    var count = outcome.result;
    if (count < 0) {
        return speak(ctx, announce, "There's no giveaway running.", { handled: "ended", entryCount: 0 });
    }
    return speak(
        ctx, announce,
        outcome.wrote
            ? "Entries are closed! " + plural(count, "viewer") + " entered."
            : "Entries were already closed. " + plural(count, "viewer") + " entered.",
        { handled: "ended", entryCount: count }
    );
}

function cancelGiveaway(ctx) {
    var outcome = update(ctx, function (state) {
        return state ? { next: null, result: true } : { result: false };
    });
    return speak(
        ctx, true,
        outcome.wrote ? "The giveaway was cancelled." : "There's no giveaway running.",
        { handled: "cancelled", cancelled: outcome.wrote }
    );
}

function reportStatus(ctx) {
    var state = parseState(ctx.storage.get(STATE_KEY));
    var message;
    if (!state) {
        message = "No giveaway right now. Mods can start one with !giveaway start.";
    } else if (state.open) {
        message = "Giveaway open! Type " + state.keyword + " to enter. " + plural(state.entrants.length, "viewer") + " so far.";
    } else {
        message = "Entries are closed with " + plural(state.entrants.length, "viewer") + ". Mods can draw with !giveaway draw.";
    }
    return speak(ctx, true, message, { handled: "status" });
}

// A reply for a Send chat message step to post. With `announce`, the reply
// also rides on a giveaways.announced event, which is what the module's
// workflow posts. Engines without ctx.success only have ctx.response, so fall
// back to it and add the fields by hand.
function speak(ctx, announce, message, fields, events) {
    var value = typeof ctx.success === "function"
        ? ctx.success(message, fields)
        : Object.assign(ctx.response(true, message), fields);
    var all = events ? events.slice() : [];
    if (announce) {
        all.push({ type: EVENT_ANNOUNCED, data: { message: message } });
    }
    return all.length > 0 ? ctx.result(value, all) : value;
}

// Read-modify-write under compareAndSet. `change` gets the current state (or
// null) and returns { next, result }: `next` is written (null clears the
// giveaway), and omitting it writes nothing. Retried from whatever value
// beat us, so two chatters entering at once both get in.
function update(ctx, change) {
    var raw = ctx.storage.get(STATE_KEY);
    for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        var outcome = change(parseState(raw));
        if (!("next" in outcome)) {
            return { wrote: false, result: outcome.result };
        }
        var value = outcome.next ? JSON.stringify(outcome.next) : "";
        var expected = typeof raw === "string" ? raw : null;
        var cas = ctx.storage.compareAndSet(STATE_KEY, expected, value);
        if (cas.swapped) {
            return { wrote: true, result: outcome.result };
        }
        raw = cas.current;
    }
    throw new Error("giveaway state kept changing underneath this update; try again");
}

function parseState(raw) {
    if (typeof raw !== "string" || raw === "") {
        return null;
    }
    try {
        var state = JSON.parse(raw);
        return state && typeof state === "object" && Array.isArray(state.entrants) ? state : null;
    } catch (e) {
        return null;
    }
}

// Chat clients append invisible characters to get around Twitch's
// duplicate-message filter, which would make "!join" fail to match.
function cleanMessage(message) {
    if (typeof message !== "string") {
        return "";
    }
    return message.replace(/[​-‍⁠﻿]|󠀀/g, "").trim();
}

function subscriberLuck(ctx) {
    return Math.min(settingNumber(ctx, "subscriberLuck", 1, 1), MAX_SUBSCRIBER_LUCK);
}

function settings(ctx) {
    return (ctx.module && ctx.module.settings) || {};
}

function settingString(ctx, key, fallback) {
    var value = settings(ctx)[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function settingNumber(ctx, key, fallback, min) {
    var value = settings(ctx)[key];
    var n = Number(value);
    if (value === "" || value === null || value === undefined || !isFinite(n) || n < min) {
        return fallback;
    }
    return n;
}

function settingBool(ctx, key) {
    var value = settings(ctx)[key];
    return value === true || value === "true";
}

function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
}
