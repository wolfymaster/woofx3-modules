/// <reference types="@woofx3/module-sdk/function-ctx" />

// Fired once a minute by the background task. Posts the next message in the
// rotation when all three gates pass: the stream is live (if the streamer
// asked for that), a full interval has passed since the last post, and chat
// has been active since then.
var MESSAGE_SETTINGS = ["message1", "message2", "message3", "message4", "message5"];
var DEFAULT_INTERVAL_MINUTES = 15;
var DEFAULT_MIN_CHAT_LINES = 5;
var MAX_ATTEMPTS = 5;

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function post_timed_message(ctx) {
    var settings = (ctx.module && ctx.module.settings) || {};

    var messages = [];
    for (var i = 0; i < MESSAGE_SETTINGS.length; i++) {
        var text = settings[MESSAGE_SETTINGS[i]];
        if (typeof text === "string" && text.trim() !== "") {
            messages.push(text.trim());
        }
    }
    if (messages.length === 0) {
        return { posted: false, reason: "no messages set" };
    }

    if (settings.onlyWhenLive !== false && settings.onlyWhenLive !== "false") {
        if (ctx.storage.get("live") !== true) {
            return { posted: false, reason: "not live" };
        }
    }

    var intervalMs = positiveNumber(settings.intervalMinutes, DEFAULT_INTERVAL_MINUTES, 1) * 60 * 1000;
    var now = Date.now();
    var lastPostedAt = ctx.storage.get("lastPostedAt");
    if (typeof lastPostedAt === "number" && now - lastPostedAt < intervalMs) {
        return { posted: false, reason: "not due yet" };
    }

    var minChatLines = positiveNumber(settings.minChatLines, DEFAULT_MIN_CHAT_LINES, 0);
    var chatLines = ctx.storage.get("chatLines");
    chatLines = typeof chatLines === "number" ? chatLines : 0;
    if (chatLines < minChatLines) {
        return { posted: false, reason: "chat too quiet", chatLines: chatLines };
    }

    // Claim this slot before posting: if two firings overlap, only the one
    // that moves lastPostedAt forward posts.
    var expectedLast = typeof lastPostedAt === "number" ? lastPostedAt : null;
    if (!ctx.storage.compareAndSet("lastPostedAt", expectedLast, now).swapped) {
        return { posted: false, reason: "already posted" };
    }

    var index = ctx.storage.get("nextIndex");
    index = typeof index === "number" && index >= 0 ? index % messages.length : 0;
    var message = messages[index];
    ctx.chat.sendMessage(message);
    ctx.storage.set("nextIndex", (index + 1) % messages.length);

    // Take off only the lines this post consumed, so messages counted while
    // it ran still count toward the next one.
    consumeChatLines(ctx, chatLines);

    return { posted: true, message: message, index: index };
}

function consumeChatLines(ctx, seen) {
    var current = seen;
    for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        var next = Math.max(0, current - seen);
        var outcome = ctx.storage.compareAndSet("chatLines", current, next);
        if (outcome.swapped) {
            return;
        }
        current = typeof outcome.current === "number" ? outcome.current : 0;
    }
    ctx.storage.set("chatLines", 0);
}

// Settings arrive coerced to numbers, but a hand-edited value can still be a
// string, blank or nonsense; fall back rather than post every minute.
function positiveNumber(value, fallback, min) {
    var n = Number(value);
    if (value === "" || value === null || value === undefined || !isFinite(n) || n < min) {
        return fallback;
    }
    return n;
}
