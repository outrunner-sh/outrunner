import { readCappedBody } from "@/lib/http/capped-body";

/** A pasted token's body is `{ "token": "…" }`, a few hundred bytes at most. */
const MAX_BODY_BYTES = 4096;

/**
 * The token a connection route was posted (`{ token }`), trimmed, or a 400
 * naming what to paste (`label`, e.g. "a GitLab personal access token"). A
 * token with a line break or NUL in it is refused: it would end up in a git
 * credential or an HTTP header.
 */
export async function readTokenBody(request: Request, label: string): Promise<string | Response> {
  const raw = await readCappedBody(request, MAX_BODY_BYTES);
  let token: unknown;
  try {
    token = raw === null ? null : (JSON.parse(raw) as { token?: unknown } | null)?.token;
  } catch {
    /* invalid JSON */
  }
  if (typeof token !== "string" || !token.trim() || /[\r\n\0]/.test(token)) {
    return Response.json({ error: `Enter ${label}.` }, { status: 400 });
  }
  return token.trim();
}
