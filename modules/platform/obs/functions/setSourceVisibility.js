function setSourceVisibility(ctx) {
  const params = readParams(ctx);
  const sourceName = requiredString(params, "sourceName");
  const sceneName = optionalString(params, "sceneName");
  const visibility = readVisibility(params);

  // Without a scene, OBS acts on whichever scene is live when the step runs.
  // `visible` goes along for an engine older than `visibility`, which reads
  // only it; there a toggle can only show the source.
  const args = { sourceName: sourceName, visibility: visibility };
  if (visibility !== "toggle") {
    args.visible = visibility === "visible";
  }
  if (sceneName !== undefined) {
    args.sceneName = sceneName;
  }
  callObs(ctx, "setSourceVisibility", args);

  const reply = ctx.response(true, DONE[visibility] + sourceName + ".");
  reply.ok = true;
  return reply;
}

const DONE = { visible: "Showed ", hidden: "Hid ", toggle: "Toggled " };

// A step saved before Visibility was a choice holds the old Visible switch
// instead; it still reads as Visible or Hidden.
function readVisibility(params) {
  const value = params.visibility;
  if (value == null || value === "") {
    return optionalBool(params, "visible", true) ? "visible" : "hidden";
  }
  if (value === "visible" || value === "hidden" || value === "toggle") {
    return value;
  }
  throw new Error('visibility must be "visible", "hidden" or "toggle".');
}

function readParams(ctx) {
  return (ctx.event && ctx.event.parameters) || ctx.event || {};
}

function requiredString(params, key) {
  const value = params[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(key + " must be a non-empty string.");
  }
  return value;
}

function optionalString(params, key) {
  const value = params[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(key + " must be a string.");
  }
  return value === "" ? undefined : value;
}

// A form may leave an untouched toggle out of the saved step instead of
// storing its default, and a toggle can be stored as "true"/"false" text, so
// absent means the default and both spellings are accepted.
function optionalBool(params, key, fallback) {
  const value = params[key];
  if (value == null) {
    return fallback;
  }
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  throw new Error(key + " must be true or false.");
}

// ctx.obs exists only on an engine that reaches OBS through module code; an
// older one has no such extension, and calling into nothing would fail far
// from the cause.
function callObs(ctx, method, args) {
  if (!ctx.obs || typeof ctx.obs[method] !== "function") {
    throw new Error("ctx.obs." + method + " is not available on this engine.");
  }
  return ctx.obs[method](args);
}
