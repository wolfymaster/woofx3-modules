function shoutout(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const raw = String(params.user == null ? "" : params.user)
    .trim()
    .replace(/^@+/, "")
    .trim();
  if (!raw) {
    return ctx.response(false, "No channel to shout out.");
  }

  // Either identifier works: a raid trigger carries the raider's id, while a
  // chat command carries whatever the chatter typed. The engine resolves a
  // name to an id before calling Twitch.
  const isId = /^[0-9]+$/.test(raw);
  const target = isId ? { userId: raw } : { userName: raw };

  // Twitch allows one shoutout every 2 minutes, so the engine queues it on
  // the dashboard's shoutout queue, which sends each in turn and retries a
  // refusal, instead of dropping one that lands too soon after another. Only
  // an engine with no dashboard queue sends at once (queued is false).
  let result;
  try {
    result = callTwitch(ctx, "shoutout", target);
  } catch (err) {
    // Only a direct send meets Twitch's rate limit; a queued shoutout waits.
    if (isOn(params.skipIfRateLimited) && err && err.code === "rate_limited") {
      const skipped = ctx.response(true, "Shoutout skipped: " + err.message);
      skipped.queued = false;
      skipped.position = 0;
      skipped.alreadyQueued = false;
      skipped.skipped = true;
      return skipped;
    }
    throw err;
  }

  let message;
  if (!result.queued) {
    message = "Shouted out " + raw + ".";
  } else if (result.alreadyQueued) {
    message = raw + " is already in the shoutout queue at #" + result.position + ".";
  } else {
    message = "Queued a shoutout for " + raw + " at #" + result.position + ".";
  }
  const reply = ctx.response(true, message);
  reply.userId = result.userId;
  reply.queued = result.queued === true;
  reply.position = result.queued ? result.position : 0;
  reply.alreadyQueued = result.alreadyQueued === true;
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
