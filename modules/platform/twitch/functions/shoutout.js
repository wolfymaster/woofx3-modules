function shoutout(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const raw = (params.user || "").trim();
  if (!raw) {
    return ctx.response(false, "No channel to shout out.");
  }

  // Either identifier works: a raid trigger carries the raider's id, while a
  // chat command carries whatever the chatter typed. The engine resolves a
  // name to an id before calling Twitch.
  const isId = /^[0-9]+$/.test(raw);
  ctx.twitch.shoutout(isId ? { userId: raw } : { userName: raw.replace(/^@/, "") });

  return ctx.response(true, "");
}
