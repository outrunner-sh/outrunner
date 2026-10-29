/** How long to wait before each resend of a create whose answer was lost:
 *  the connection that dropped it may take a while to come back, and the
 *  first send may still be doing GitHub's checks before it makes the row. */
const RESEND_AFTER_MS = [1_000, 2_000, 4_000];

/**
 * Send a create, and send it again, the same, while no answer comes back.
 * A lost answer doesn't mean no session: the first send may have made it, or
 * may still be making it. The same id sent again is the server's to settle
 * (lib/session/create-cloud-session.ts): whichever send makes the row, every
 * other gets that session back. Null when none got through at all.
 */
export async function sendCreate(
  url: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    } catch {
      if (attempt >= RESEND_AFTER_MS.length) return null;
      await wait(RESEND_AFTER_MS[attempt]);
    }
  }
}
