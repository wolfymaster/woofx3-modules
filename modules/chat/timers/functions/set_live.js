/// <reference types="@woofx3/module-sdk/function-ctx" />

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function set_live(ctx) {
    var params = (ctx.event && ctx.event.parameters) || {};
    var live = params.live === true || params.live === "true";

    ctx.storage.set("live", live);
    if (live) {
        // Start the clock at go-live, so the first message waits a full
        // interval instead of firing the moment the stream starts, and chat
        // left over from last stream doesn't count toward it.
        ctx.storage.set("lastPostedAt", Date.now());
        ctx.storage.set("chatLines", 0);
    }
    return { live: live };
}
