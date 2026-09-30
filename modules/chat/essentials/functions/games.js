/// <reference types="@woofx3/module-sdk/function-ctx" />

var DEFAULT_EIGHT_BALL = [
    "It is certain.", "Without a doubt.", "You may rely on it.", "Yes, definitely.",
    "As I see it, yes.", "Most likely.", "Outlook good.", "Signs point to yes.",
    "Reply hazy, try again.", "Ask again later.", "Better not tell you now.",
    "Cannot predict now.", "Don't count on it.", "My reply is no.",
    "My sources say no.", "Outlook not so good.", "Very doubtful."
];

// Big enough for any tabletop roll, small enough that the reply fits in one
// chat message.
var MAX_DICE = 20;
var MAX_SIDES = 1000;

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function eightBall(ctx) {
    var question = inputText(ctx, "question");
    if (!question) {
        return reply(ctx, false, "Ask the magic 8-ball a question, like: !8ball Will I win this round?");
    }
    var answers = customAnswers(ctx);
    var answer = answers[Math.floor(Math.random() * answers.length)];
    var result = reply(ctx, true, "🎱 " + answer);
    result.answer = answer;
    return result;
}

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function roll(ctx) {
    var spec = parseDice(inputText(ctx, "dice"));
    if (!spec) {
        return reply(ctx, false, "Try something like !roll, !roll 20 or !roll 2d6 (up to " + MAX_DICE + " dice with " + MAX_SIDES + " sides).");
    }

    var rolls = [];
    var total = 0;
    for (var i = 0; i < spec.count; i++) {
        var value = 1 + Math.floor(Math.random() * spec.sides);
        rolls.push(value);
        total += value;
    }

    var name = chatterName(ctx);
    var who = name ? name + " rolled " : "Rolled ";
    var message = spec.count === 1
        ? who + "a " + total + " (d" + spec.sides + ")."
        : who + total + " on " + spec.count + "d" + spec.sides + " (" + rolls.join(", ") + ").";
    var result = reply(ctx, true, "🎲 " + message);
    result.total = total;
    result.rolls = rolls;
    return result;
}

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function coinflip(ctx) {
    var side = Math.random() < 0.5 ? "Heads" : "Tails";
    var result = reply(ctx, true, "🪙 " + side + "!");
    result.side = side.toLowerCase();
    return result;
}

// Accepts "", "20" (one die with 20 sides), "d20" and "3d6". Anything out of
// range is refused rather than clamped, so a viewer never sees a roll that
// isn't the one they asked for.
function parseDice(text) {
    var raw = String(text || "").trim().toLowerCase();
    if (raw === "") {
        return { count: 1, sides: 6 };
    }
    var match = raw.match(/^(\d*)d(\d+)$/) || raw.match(/^()(\d+)$/);
    if (!match) {
        return null;
    }
    var count = match[1] === "" ? 1 : parseInt(match[1], 10);
    var sides = parseInt(match[2], 10);
    if (!(count >= 1 && count <= MAX_DICE && sides >= 2 && sides <= MAX_SIDES)) {
        return null;
    }
    return { count: count, sides: sides };
}

function customAnswers(ctx) {
    var settings = (ctx.module && ctx.module.settings) || {};
    var raw = typeof settings.eightBallAnswers === "string" ? settings.eightBallAnswers : "";
    var answers = raw.split("|").map(function (s) { return s.trim(); }).filter(function (s) { return s !== ""; });
    return answers.length > 0 ? answers : DEFAULT_EIGHT_BALL;
}

// A chat command's argument text arrives as data.text; a workflow step sets
// the named parameter instead.
function inputText(ctx, paramKey) {
    var event = ctx.event || {};
    var params = event.parameters || {};
    if (params[paramKey] !== undefined && params[paramKey] !== null && String(params[paramKey]).trim() !== "") {
        return String(params[paramKey]).trim();
    }
    var data = event.data || {};
    return typeof data.text === "string" ? data.text.trim() : "";
}

function chatterName(ctx) {
    var data = (ctx.event && ctx.event.data) || {};
    return String(data.chatter || data.chatterName || "").replace(/^@/, "").trim();
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
