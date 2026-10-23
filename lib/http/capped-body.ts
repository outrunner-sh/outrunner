/**
 * Read a request body as text, but only as far as `limit` bytes: past it the
 * reader is cancelled and the rest is never read into memory. `content-length`
 * is a fast path when it is there — a chunked body omits it, which is why the
 * count itself is the bound and the header only a shortcut.
 */

/** The body as text, or null once it passes `limit` bytes. */
export async function readCappedBody(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
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
  return text + decoder.decode();
}
