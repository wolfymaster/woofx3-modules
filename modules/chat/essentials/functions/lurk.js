/// <reference types="@woofx3/module-sdk/function-ctx" />

var DEFAULT_LURK = "{user} is heading into lurk mode. Thanks for hanging out, we'll keep your seat warm!";
var DEFAULT_UNLURK = "Welcome back, {user}! Great to see you again.";

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function lurk(ctx) {
    return announce(ctx, "lurkMessage", DEFAULT_LURK);
}

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function unlurk(ctx) {
    return announce(ctx, "unlurkMessage", DEFAULT_UNLURK);
}

function announce(ctx, settingKey, fallback) {
    var template = setting(ctx, settingKey) || fallback;
    var message = template.split("{user}").join(chatterName(ctx));
    var result = reply(ctx, true, message);
    result.user = chatterName(ctx);
    return result;
}

// A chat command carries the chatter as data.chatter; a chat-message trigger
// as data.chatterName; a hand-built workflow can pass one as a parameter.
function chatterName(ctx) {
    var event = ctx.event || {};
    var params = event.parameters || {};
    var data = event.data || {};
    var name = params.user || data.chatter || data.chatterName || data.userName || "";
    name = String(name).replace(/^@/, "").trim();
    return name || "Someone";
}

function setting(ctx, key) {
    var settings = (ctx.module && ctx.module.settings) || {};
    var value = settings[key];
    return typeof value === "string" ? value.trim() : "";
}

// The function returns what should be said; a "Send chat message" step posts
// ${step.message}. Engines without ctx.success/ctx.failure only have
// ctx.response, so fall back to it and add the fields by hand.
function reply(ctx, ok, message) {
    var build = ok ? ctx.success : ctx.failure;
    if (typeof build === "function") {
        return build(message, { ok: ok });
    }
    var result = ctx.response(ok, message);
    result.ok = ok;
    return result;
}
