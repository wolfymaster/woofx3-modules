function increment(ctx) {
  const params = (ctx.event && ctx.event.parameters) || ctx.event || {};
  const step = Number(params.step || 1);
  const current = Number(params.current || 0);
  return { next: current + step };
}
