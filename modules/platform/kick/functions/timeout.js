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

  // A trigger carries the chatter's Kick id, a chat command carries the
  // channel name someone typed.
  const isId = /^[0-9]+$/.test(raw);
  const args = isId ? { userId: raw } : { userName: raw.replace(/^@/, "") };
  args.durationSeconds = durationSeconds;
  const reason = String(params.reason == null ? "" : params.reason).trim();
  if (reason) {
    args.reason = reason;
  }

  // Kick counts whole minutes, so the applied duration can be longer than asked.
  const result = callKick(ctx, "timeout", args);

  const reply = ctx.response(true, "Timed out " + raw + " for " + result.durationSeconds + "s.");
  reply.userId = result.userId;
  reply.durationSeconds = result.durationSeconds;
  return reply;
}

// An engine without Kick support has no ctx.kick, and reading a result off
// nothing would fail far from the cause.
function callKick(ctx, method, args) {
  if (!ctx.kick || typeof ctx.kick[method] !== "function") {
    throw new Error("ctx.kick." + method + " is not available on this engine.");
  }
  const result = ctx.kick[method](args);
  if (!result || typeof result !== "object") {
    throw new Error("ctx.kick." + method + " returned no result.");
  }
  return result;
}
