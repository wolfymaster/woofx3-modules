/// <reference types="@woofx3/module-sdk/function-ctx" />

var STREAM_STARTED_KEY = "stream_started_at";

// Runs from the bundled workflow on stream.online. Twitch's own start time is
// preferred over "now": the event can arrive late, and a restart of the
// engine mid-stream would otherwise reset the clock.
/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function recordStreamStart(ctx) {
    var data = (ctx.event && ctx.event.data) || {};
    var startedAt = typeof data.startedAt === "string" && !isNaN(Date.parse(data.startedAt))
        ? data.startedAt
        : new Date().toISOString();
    ctx.storage.set(STREAM_STARTED_KEY, startedAt);
    return { ok: true, startedAt: startedAt };
}

// Runs from the bundled workflow on stream.offline. Storage has no delete,
// so an empty string stands for "offline".
/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function clearStreamStart(ctx) {
    ctx.storage.set(STREAM_STARTED_KEY, "");
    return { ok: true, live: false };
}
