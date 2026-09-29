function clip(ctx) {
  const result = callTwitch(ctx, "clip", {});

  const reply = ctx.response(true, "Clip created: " + result.url);
  reply.id = result.id;
  reply.url = result.url;
  return reply;
}

// ctx.twitch answers with the twitch service's result only on an engine whose
// Twitch calls are request/reply; an older one returns nothing or lacks the
// method, and reading a result off that would fail far from the cause.
function callTwitch(ctx, method, args) {
  if (!ctx.twitch || typeof ctx.twitch[method] !== "function") {
    throw new Error("ctx.twitch." + method + " is not available on this engine.");
  }
  const result = ctx.twitch[method](args);
  if (!result || typeof result !== "object") {
    throw new Error("ctx.twitch." + method + " returned no result: this engine does not return Twitch results yet.");
  }
  return result;
}
