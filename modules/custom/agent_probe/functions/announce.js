export function announce(ctx) {
  const who = ctx?.parameters?.user ?? "someone";
  return { message: `probe saw ${who}` };
}
