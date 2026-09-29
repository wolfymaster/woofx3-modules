function switchScene(ctx) {
  const params = readParams(ctx);
  const sceneName = requiredString(params, "sceneName");

  callObs(ctx, "switchScene", { sceneName: sceneName });

  const reply = ctx.response(true, "Switched to " + sceneName + ".");
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

// ctx.obs exists only on an engine that reaches OBS through module code; an
// older one has no such extension, and calling into nothing would fail far
// from the cause.
function callObs(ctx, method, args) {
  if (!ctx.obs || typeof ctx.obs[method] !== "function") {
    throw new Error("ctx.obs." + method + " is not available on this engine.");
  }
  return ctx.obs[method](args);
}
