/**
 * Read a request body as text, but only as far as `limit` bytes: past it the
 * reader is cancelled and the rest is never read into memory. `content-length`
 * is a fast path when it is there — a chunked body omits it, which is why the
 * count itself is the bound and the header only a shortcut.
 *
 * A body that fails partway — the client dropped, a tab closed mid-report —
 * reads as null too: there is no body to work with either way, and the caller
 * treats it as malformed rather than letting the read error become a 500.
 */

/** The body as text, or null once it passes `limit` bytes or fails to read. */
export async function readCappedBody(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) {
        // Stop here: what follows is over the limit and need not be read at all.
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(result.value, { stream: true });
    }
  } catch {
    // The body couldn't be read to the end; nothing usable came of it.
    await reader.cancel().catch(() => undefined);
    return null;
  }
  return text + decoder.decode();
}
