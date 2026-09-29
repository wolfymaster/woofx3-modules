function shoutout(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const raw = String(params.user == null ? "" : params.user).trim();
  if (!raw) {
    return ctx.response(false, "No channel to shout out.");
  }

  // Either identifier works: a raid trigger carries the raider's id, while a
  // chat command carries whatever the chatter typed. The engine resolves a
  // name to an id before calling Twitch.
  const isId = /^[0-9]+$/.test(raw);
  const target = isId ? { userId: raw } : { userName: raw.replace(/^@/, "") };

  let result;
  try {
    result = callTwitch(ctx, "shoutout", target);
  } catch (err) {
    // Twitch allows one shoutout every 2 minutes, so back-to-back raids hit
    // the limit; a workflow that shouts out raiders can opt to carry on.
    if (isOn(params.skipIfRateLimited) && err && err.code === "rate_limited") {
      const skipped = ctx.response(true, "Shoutout skipped: " + err.message);
      skipped.skipped = true;
      return skipped;
    }
    throw err;
  }

  const reply = ctx.response(true, "Shouted out " + raw + ".");
  reply.userId = result.userId;
  reply.skipped = false;
  return reply;
}

function isOn(value) {
  return value === true || value === "true";
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
