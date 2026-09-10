export function increment(ctx) {
  const step = Number(ctx?.parameters?.step ?? 1);
  const current = Number(ctx?.parameters?.current ?? 0);
  return { next: current + step };
}
