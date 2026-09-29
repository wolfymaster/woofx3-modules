// Options for the audio inputs picker, as { value, label, group? }. Runs from the
// field-options responder, which replies with whatever this returns.
function listInputs(ctx) {
  const options = callObs(ctx, "listInputs");
  return Array.isArray(options) ? options : [];
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
