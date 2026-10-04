/// <reference types="@woofx3/module-sdk/function-ctx" />

// Stream Credits: collects who supported, raided and chatted this stream, for
// the credits widget to roll. The widget only reads storage; everything it
// shows is written here.
//
// Storage layout. Each value is a JSON *string* this file serialises itself,
// because compareAndSet compares the stored bytes: handing back the exact
// string that was read is what makes the comparison reliable.
//
//   supporters  [{"key","name","bits","gifts"}]   in order of first support
//   raiders     [{"key","name","viewers"}]        in order of first raid
//   chatters    [{"key","name"}]                  in order of first message
//
// Three keys rather than one so that the steady stream of chat writes doesn't
// contend with a cheer or a raid landing at the same moment. Everything is
// written clearOnSessionEnd, so the credits start fresh every stream.

var CAS_ATTEMPTS = 8;
// A chatter list this long already takes minutes to roll; past it, a busy
// channel's credits would never finish and the stored value keeps growing.
var MAX_CHATTERS = 1000;
var STORE_OPTIONS = { clearOnSessionEnd: true };

// ---------------------------------------------------------------------------
// Event entry points (run by the module's own workflows)
// ---------------------------------------------------------------------------

/** channel.cheer: { userName, isAnonymous, amount } */
function record_cheer(ctx) {
    var data = eventData(ctx);
    var bits = wholeNumber(data.amount);
    if (bits <= 0) {
        return { supporters: readList(ctx, "supporters").list.length, skipped: "no bits" };
    }
    var who = person(data.isAnonymous ? "" : data.userName);
    var list = upsert(ctx, "supporters", who, function (entry) {
        entry.bits = (Number(entry.bits) || 0) + bits;
    });
    return { supporters: list.length };
}

/** channel.subscriptionGift: { gifterName, isAnonymous, amount } */
function record_gift(ctx) {
    var data = eventData(ctx);
    var count = wholeNumber(data.amount);
    if (count <= 0) {
        return { supporters: readList(ctx, "supporters").list.length, skipped: "no subs" };
    }
    var who = person(data.isAnonymous ? "" : data.gifterName);
    var list = upsert(ctx, "supporters", who, function (entry) {
        entry.gifts = (Number(entry.gifts) || 0) + count;
    });
    return { supporters: list.length };
}

/** channel.raid: { fromBroadcasterUserName, viewers } */
function record_raid(ctx) {
    var data = eventData(ctx);
    var who = person(data.fromBroadcasterUserName);
    if (who.key === "anonymous") {
        return { raiders: readList(ctx, "raiders").list.length, skipped: "no raider" };
    }
    var viewers = Math.max(0, wholeNumber(data.viewers));
    var list = upsert(ctx, "raiders", who, function (entry) {
        entry.viewers = (Number(entry.viewers) || 0) + viewers;
    });
    return { raiders: list.length };
}

/**
 * user.message: adds the chatter the first time they speak, and lets
 * moderators clear the credits with !resetcredits. Most messages come from
 * someone already listed, and those return without writing, so chat doesn't
 * churn storage (and every widget watching it) on each line.
 */
function handle_chat_message(ctx) {
    var data = eventData(ctx);
    var membership = data.membership || {};
    var message = str(data.message).trim();

    if (message.split(/\s+/)[0].toLowerCase() === "!resetcredits") {
        if (membership.isModerator === true || membership.isBroadcaster === true) {
            resetCredits(ctx);
            say(ctx, "The stream credits are wiped clean. Fresh start!");
            return { command: "resetcredits", added: false };
        }
    }

    // The streamer is in their own credits already.
    if (membership.isBroadcaster === true) {
        return { command: "", added: false };
    }
    var who = person(data.chatterName);
    if (who.key === "anonymous" || ignoredNames(ctx).indexOf(who.key) !== -1) {
        return { command: "", added: false };
    }

    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var read = readList(ctx, "chatters");
        if (indexOfKey(read.list, who.key) !== -1 || read.list.length >= MAX_CHATTERS) {
            return { command: "", added: false };
        }
        read.list.push({ key: who.key, name: who.name });
        if (ctx.storage.compareAndSet("chatters", read.raw, JSON.stringify(read.list), STORE_OPTIONS).swapped) {
            return { command: "", added: true };
        }
    }
    throw new Error("the chatter list kept changing underneath this update; try again.");
}

// ---------------------------------------------------------------------------
// Action entry points (for workflows, buttons and stream decks)
// ---------------------------------------------------------------------------

function reset_credits(ctx) {
    resetCredits(ctx);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function readList(ctx, key) {
    var raw = ctx.storage.get(key);
    var list = parseJson(raw);
    return { raw: raw === undefined ? null : raw, list: Array.isArray(list) ? list : [] };
}

// Finds `who` in the list under `key`, adding them at the end when they're
// new, then lets `change` add to their entry. Returns the list as written.
function upsert(ctx, key, who, change) {
    for (var attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        var read = readList(ctx, key);
        var list = read.list;
        var i = indexOfKey(list, who.key);
        if (i === -1) {
            list.push({ key: who.key, name: who.name });
            i = list.length - 1;
        }
        // A later event carries the name as they display it now.
        list[i].name = who.name;
        change(list[i]);
        if (ctx.storage.compareAndSet(key, read.raw, JSON.stringify(list), STORE_OPTIONS).swapped) {
            return list;
        }
    }
    throw new Error(key + " kept changing underneath this update; try again.");
}

function resetCredits(ctx) {
    ["supporters", "raiders", "chatters"].forEach(function (key) {
        ctx.storage.set(key, "[]", STORE_OPTIONS);
    });
}

function indexOfKey(list, key) {
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === key) {
            return i;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function person(name) {
    var display = str(name).trim();
    if (!display) {
        return { key: "anonymous", name: "Anonymous" };
    }
    return { key: display.toLowerCase(), name: display };
}

// The "Leave out of the credits" setting: names separated by commas or spaces.
function ignoredNames(ctx) {
    var settings = (ctx.module && ctx.module.settings) || {};
    return str(settings.ignoredNames)
        .toLowerCase()
        .split(/[\s,]+/)
        .map(function (n) { return n.replace(/^@/, ""); })
        .filter(function (n) { return n !== ""; });
}

function eventData(ctx) {
    return (ctx.event && ctx.event.data) || {};
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
