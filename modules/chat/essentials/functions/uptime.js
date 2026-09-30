/// <reference types="@woofx3/module-sdk/function-ctx" />

// The start time is kept by recordStreamStart/clearStreamStart, which the
// module's bundled workflows run on stream.online and stream.offline. Storage
// has no delete, so "offline" is an empty string rather than a missing key;
// a missing key means the module has never seen the stream start at all.
var STREAM_STARTED_KEY = "stream_started_at";

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function uptime(ctx) {
    var started = ctx.storage.get(STREAM_STARTED_KEY);
    var startedMs = typeof started === "string" && started !== "" ? Date.parse(started) : NaN;

    if (started === null || started === undefined) {
        return reply(ctx, false, "I haven't seen the stream go live yet, so I don't know how long it's been up.");
    }
    if (isNaN(startedMs)) {
        return reply(ctx, true, "The stream is offline right now.");
    }

    var seconds = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
    var result = reply(ctx, true, "The stream has been live for " + formatDuration(seconds) + ".");
    result.live = true;
    result.uptimeSeconds = seconds;
    return result;
}

function formatDuration(totalSeconds) {
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    var parts = [];
    if (hours > 0) { parts.push(hours + (hours === 1 ? " hour" : " hours")); }
    if (minutes > 0) { parts.push(minutes + (minutes === 1 ? " minute" : " minutes")); }
    if (hours === 0 && (minutes === 0 || seconds > 0)) {
        parts.push(seconds + (seconds === 1 ? " second" : " seconds"));
    }
    return parts.join(", ");
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
