function updateStream(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const title = text(params.title);
  const category = text(params.category);
  const tags = tagList(params.tags);

  // A blank field means "leave it as it is", so a step can change the title
  // alone. Whether anything is left to change, and what Twitch accepts, is the
  // twitch service's call.
  const args = {};
  if (title) {
    args.title = title;
  }
  if (category) {
    args.category = category;
  }
  if (tags.length > 0) {
    args.tags = tags;
  }

  const result = callTwitch(ctx, "updateStream", args);

  const reply = ctx.response(true, "Stream updated.");
  const fields = ["title", "categoryId", "categoryName", "tags"];
  for (let i = 0; i < fields.length; i++) {
    if (result[fields[i]] !== undefined) {
      reply[fields[i]] = result[fields[i]];
    }
  }
  return reply;
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

// The field is comma-separated text; a list is accepted too, for a value
// substituted from an earlier step.
function tagList(value) {
  const parts = Array.isArray(value) ? value : text(value).split(",");
  const tags = [];
  for (let i = 0; i < parts.length; i++) {
    const tag = text(parts[i]);
    if (tag) {
      tags.push(tag);
    }
  }
  return tags;
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
