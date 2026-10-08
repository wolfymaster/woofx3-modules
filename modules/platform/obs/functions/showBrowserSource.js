function showBrowserSource(ctx) {
  const params = readParams(ctx);
  const url = requiredString(params, "url");
  const sourceName = requiredString(params, "sourceName");
  const sceneName = optionalString(params, "sceneName");

  // Without a scene, OBS acts on whichever scene is live when the step runs.
  // A source by this name is reused (its address changed, and added to the
  // scene if it isn't there), so running the step again doesn't pile up copies.
  const args = { sourceName: sourceName, url: url };
  if (sceneName !== undefined) {
    args.sceneName = sceneName;
  }
  callObs(ctx, "showBrowserSource", args);

  const reply = ctx.response(true, "Showing " + url + " in " + sourceName + ".");
  reply.ok = true;
  return reply;
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

// ctx.obs exists only on an engine that reaches OBS through module code; an
// older one has no such extension, and calling into nothing would fail far
// from the cause.
function callObs(ctx, method, args) {
  if (!ctx.obs || typeof ctx.obs[method] !== "function") {
    throw new Error("ctx.obs." + method + " is not available on this engine.");
  }
  return ctx.obs[method](args);
}
