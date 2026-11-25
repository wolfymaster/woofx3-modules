function updateStream(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const title = text(params.title);
  const category = text(params.category);
  const tags = tagList(params.tags);

  // A blank field means "leave it as it is", so a step can change the title
  // alone. What Kick accepts is the Kick connection's call.
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

  const result = callKick(ctx, "updateStream", args);

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
