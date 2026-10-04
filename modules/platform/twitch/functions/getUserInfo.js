// Keys copied onto the step's result as-is, for later steps to reference.
const FIELDS = [
  "userId",
  "login",
  "displayName",
  "description",
  "profileImageUrl",
  "broadcasterType",
  "createdAt",
  "title",
  "categoryId",
  "categoryName",
  "tags",
  "language",
  "isLive",
];

function getUserInfo(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const raw = sanitizeUser(params.user);
  if (!raw) {
    return ctx.response(false, "No user to look up.");
  }

  // Same identifier rule as shoutout: a trigger carries the user's id, a chat
  // command carries what someone typed.
  const isId = /^[0-9]+$/.test(raw);
  const target = isId ? { userId: raw } : { userName: raw };

  const result = callTwitch(ctx, "getUser", target);

  let summary;
  if (result.isLive && result.stream) {
    summary = result.displayName + " is live in " + result.stream.categoryName + ".";
  } else if (result.categoryName) {
    summary = result.displayName + " was last streaming " + result.categoryName + ".";
  } else {
    summary = result.displayName + " has not set a category.";
  }
  const reply = ctx.response(true, summary);
  for (let i = 0; i < FIELDS.length; i++) {
    reply[FIELDS[i]] = result[FIELDS[i]];
  }
  // The name as typed, cleaned up, for a later step that wants what the
  // chatter meant rather than Twitch's spelling. An id has no typed name, so
  // it falls back to the login, which is the same text in canonical form.
  reply.userName = isId ? result.login : raw;
  // Flattened so a later step can reference each without a nested path. The
  // live fields are empty rather than absent while offline, so a template
  // that uses them renders blank instead of failing.
  const stream = result.stream;
  reply.streamTitle = stream ? stream.title : "";
  reply.streamCategoryName = stream ? stream.categoryName : "";
  reply.viewerCount = stream ? stream.viewerCount : 0;
  reply.streamStartedAt = stream ? stream.startedAt : "";
  return reply;
}

// "  @WolfyMaster " -> "wolfymaster". Twitch logins are lowercase and a chat
// command often carries the @ and stray spaces; a numeric id passes through.
function sanitizeUser(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/^@+/, "")
    .trim()
    .toLowerCase();
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
