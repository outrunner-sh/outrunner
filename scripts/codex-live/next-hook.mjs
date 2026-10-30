export async function resolve(s, c, next) {
  if (s === "next/headers" || s === "next/server") return next(s + ".js", c);
  return next(s, c);
}
