// Keys copied onto the step's result as-is, for later steps to reference.
const FIELDS = [
  "userId",
  "login",
  "displayName",
  "description",
  "profileImageUrl",
  "title",
  "categoryId",
  "categoryName",
  "tags",
  "language",
  "isLive",
  "viewerCount",
  "streamStartedAt",
];

function getUserInfo(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const raw = sanitizeUser(params.user);
  if (!raw) {
    return ctx.response(false, "No user to look up.");
  }

  // A trigger carries the user's Kick id, a chat command carries the channel
  // name someone typed.
  const isId = /^[0-9]+$/.test(raw);
  const result = callKick(ctx, "getUser", isId ? { userId: raw } : { userName: raw });

  let summary;
  if (result.isLive) {
    summary = result.displayName + " is live in " + (result.categoryName || "no category") + ".";
  } else if (result.categoryName) {
    summary = result.displayName + " was last streaming " + result.categoryName + ".";
  } else {
    summary = result.displayName + " has not set a category.";
  }
  const reply = ctx.response(true, summary);
  for (let i = 0; i < FIELDS.length; i++) {
    reply[FIELDS[i]] = result[FIELDS[i]];
  }
  // The name as typed, cleaned up; an id has no typed name, so it falls back
  // to the channel name.
  reply.userName = isId ? result.login : raw;
  return reply;
}

// "  @Pup-Pal " -> "pup-pal". Kick channel names are lowercase and a chat
// command often carries the @ and stray spaces; a numeric id passes through.
function sanitizeUser(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/^@+/, "")
    .trim()
    .toLowerCase();
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
