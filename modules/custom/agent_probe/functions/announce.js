function announce(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const who = params.user || "someone";
  return { message: "probe saw " + who };
}
