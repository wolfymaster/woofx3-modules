function createMarker(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const description = String(params.description == null ? "" : params.description).trim();

  const result = callTwitch(ctx, "createMarker", description ? { description: description } : {});

  const reply = ctx.response(true, "Stream marker placed at " + result.positionSeconds + "s.");
  reply.id = result.id;
  reply.createdAt = result.createdAt;
  reply.description = result.description;
  reply.positionSeconds = result.positionSeconds;
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
