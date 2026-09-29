function setInputMute(ctx) {
  const params = readParams(ctx);
  const inputName = requiredString(params, "inputName");
  const muted = optionalBool(params, "muted", true);

  callObs(ctx, "setInputMute", { inputName: inputName, muted: muted });

  const reply = ctx.response(true, (muted ? "Muted " : "Unmuted ") + inputName + ".");
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
