/// <reference types="@woofx3/module-sdk/function-ctx" />

// Every quote lives in one key, as a JSON array of { number, text, addedBy,
// date }. One key keeps !quote to a single read, and compareAndSet on the
// whole string makes two mods adding at once both land instead of one
// overwriting the other. Numbers are never reused, so "quote #12" keeps
// meaning the same quote after an earlier one is deleted.
var QUOTES_KEY = "quotes";
var MAX_CAS_ATTEMPTS = 5;
var MAX_QUOTE_LENGTH = 400;

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function quote(ctx) {
    var quotes = readQuotes(ctx.storage.get(QUOTES_KEY));
    if (quotes.length === 0) {
        return reply(ctx, false, "There are no quotes yet. Mods can add one with !addquote.");
    }

    var wanted = inputText(ctx, "number").replace(/^#/, "");
    var chosen;
    if (wanted === "") {
        chosen = quotes[Math.floor(Math.random() * quotes.length)];
    } else {
        var number = parseInt(wanted, 10);
        if (!/^\d+$/.test(wanted)) {
            return reply(ctx, false, "Use !quote for a random quote, or !quote 5 for quote #5.");
        }
        chosen = findQuote(quotes, number);
        if (!chosen) {
            return reply(ctx, false, "There's no quote #" + number + ".");
        }
    }

    var result = reply(ctx, true, formatQuote(chosen));
    result.number = chosen.number;
    result.text = chosen.text;
    return result;
}

// Runs on every chat message, from the bundled workflow on user.message: the
// chat-message event is the only one that says whether the chatter is a mod,
// and a manifest command's requiredRole is not enforced. Anything that isn't
// !addquote or !delquote is ignored straight away.
/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function manageQuotes(ctx) {
    var data = (ctx.event && ctx.event.data) || {};
    var message = typeof data.message === "string" ? data.message.trim() : "";
    var match = message.match(/^!(addquote|delquote)(?:\s+([\s\S]*))?$/i);
    if (!match) {
        return { ok: true, handled: false };
    }

    var command = match[1].toLowerCase();
    var argument = (match[2] || "").trim();
    var membership = data.membership || {};
    if (membership.isModerator !== true && membership.isBroadcaster !== true) {
        var denied = reply(ctx, false, "Sorry " + (data.chatterName || "friend") + ", only mods can change quotes.");
        denied.handled = true;
        return denied;
    }

    var result = command === "addquote"
        ? addQuote(ctx, argument, data.chatterName || "")
        : deleteQuote(ctx, argument);
    result.handled = true;
    return result;
}

function addQuote(ctx, text, addedBy) {
    if (text === "") {
        return reply(ctx, false, "Add a quote like this: !addquote Never gonna give you up");
    }
    if (text.length > MAX_QUOTE_LENGTH) {
        return reply(ctx, false, "That quote is too long. Keep it under " + MAX_QUOTE_LENGTH + " characters.");
    }

    var added = null;
    var ok = updateQuotes(ctx, function (quotes) {
        var next = 1;
        for (var i = 0; i < quotes.length; i++) {
            if (quotes[i].number >= next) { next = quotes[i].number + 1; }
        }
        added = { number: next, text: text, addedBy: addedBy, date: new Date().toISOString().slice(0, 10) };
        return quotes.concat([added]);
    });
    if (!ok) {
        return reply(ctx, false, "Couldn't save that quote right now. Please try again.");
    }

    var result = reply(ctx, true, "Added quote #" + added.number + ": \"" + text + "\"");
    result.number = added.number;
    return result;
}

function deleteQuote(ctx, argument) {
    var wanted = argument.replace(/^#/, "");
    if (!/^\d+$/.test(wanted)) {
        return reply(ctx, false, "Delete a quote by its number, like: !delquote 5");
    }
    var number = parseInt(wanted, 10);

    var found = false;
    var ok = updateQuotes(ctx, function (quotes) {
        var kept = quotes.filter(function (q) { return q.number !== number; });
        found = kept.length !== quotes.length;
        return found ? kept : null;
    });
    if (!ok) {
        return reply(ctx, false, "Couldn't delete that quote right now. Please try again.");
    }
    if (!found) {
        return reply(ctx, false, "There's no quote #" + number + ".");
    }
    var result = reply(ctx, true, "Deleted quote #" + number + ".");
    result.number = number;
    return result;
}

// Applies change to the current list and writes it back only if nobody else
// wrote in between, retrying from whatever they wrote. change returns null to
// make no write at all.
function updateQuotes(ctx, change) {
    var current = ctx.storage.get(QUOTES_KEY);
    for (var attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
        var next = change(readQuotes(current));
        if (next === null) {
            return true;
        }
        var outcome = ctx.storage.compareAndSet(QUOTES_KEY, current === undefined ? null : current, JSON.stringify(next));
        if (outcome && outcome.swapped) {
            return true;
        }
        current = outcome ? outcome.current : ctx.storage.get(QUOTES_KEY);
    }
    return false;
}

function readQuotes(stored) {
    if (typeof stored !== "string" || stored === "") {
        return [];
    }
    try {
        var parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return [];
    }
}

function findQuote(quotes, number) {
    for (var i = 0; i < quotes.length; i++) {
        if (quotes[i].number === number) { return quotes[i]; }
    }
    return null;
}

function formatQuote(q) {
    return "Quote #" + q.number + ": \"" + q.text + "\"" + (q.date ? " (" + q.date + ")" : "");
}

function inputText(ctx, paramKey) {
    var event = ctx.event || {};
    var params = event.parameters || {};
    if (params[paramKey] !== undefined && params[paramKey] !== null && String(params[paramKey]).trim() !== "") {
        return String(params[paramKey]).trim();
    }
    var data = event.data || {};
    return typeof data.text === "string" ? data.text.trim() : "";
}

// A command's actions reach chat only through the chat extension: the
// command path does not turn a returned ctx.response into a reply. The same
// text rides on the result for a workflow to reuse as ${step.message}.
function reply(ctx, ok, message) {
    if (ctx.chat && typeof ctx.chat.sendMessage === "function") {
        ctx.chat.sendMessage(message);
    }
    var result = ctx.response(ok, message);
    result.ok = ok;
    return result;
}
