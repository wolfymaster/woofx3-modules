// Must match the durationSeconds defaultValue in manifest.json, for a step
// saved before the field held a value.
const DEFAULT_DURATION_SECONDS = 600;

function timeout(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const raw = String(params.user == null ? "" : params.user).trim();
  if (!raw) {
    return ctx.response(false, "No chatter to time out.");
  }

  const durationRaw = params.durationSeconds;
  const durationSeconds = durationRaw == null || durationRaw === "" ? DEFAULT_DURATION_SECONDS : Number(durationRaw);
  if (!isFinite(durationSeconds)) {
    return ctx.response(false, "Timeout duration must be a number of seconds.");
  }

  // Same identifier rule as shoutout: a trigger carries the chatter's id, a
  // chat command carries what someone typed.
  const isId = /^[0-9]+$/.test(raw);
  const args = isId ? { userId: raw } : { userName: raw.replace(/^@/, "") };
  args.durationSeconds = durationSeconds;
  const reason = String(params.reason == null ? "" : params.reason).trim();
  if (reason) {
    args.reason = reason;
  }

  const result = callTwitch(ctx, "timeout", args);

  const reply = ctx.response(true, "Timed out " + raw + " for " + result.durationSeconds + "s.");
  reply.userId = result.userId;
  reply.durationSeconds = result.durationSeconds;
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
