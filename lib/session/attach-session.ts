import { SessionUrls } from "@/lib/runtime/agent-protocol";
import { chatRoute } from "@/lib/session/chats";
import { BOX_RESTORE_FAILED } from "@/lib/session/session-codes";

const RETRY_DELAYS_MS = [1000, 2000];

/** A failure with no code of Outrunner's, so the server never answered it: a
 *  gateway's (502, 503, 504, Cloudflare's 520-524), or a 500 from the edge
 *  while the control plane is replaced in a deploy (a 500 with an `error`
 *  is the server's own answer). Worth trying again; a refusal the server
 *  answered carries its code, or names what happened. */
const UNANSWERED_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524]);

export class AttachError extends Error {
  readonly code: string | null;
  readonly retryable: boolean;
  constructor(message: string, code: string | null, retryable = false) {
    super(message);
    this.name = "AttachError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Whether an attach failed on the way (a network error, a 502/503/504, a
 *  restore that failed), so trying again can help; a refusal that names what
 *  happened (the box is gone, the session ended, …) can't be helped by it. */
export function retryableAttachFailure(error: unknown): boolean {
  return error instanceof AttachError ? error.retryable : error instanceof TypeError;
}

/** A short provider or network outage should recover before showing a failed
 *  box. Retries refresh its endpoint, are bounded, and stop when the page leaves. */
export async function attachCloudSession(
  workspaceId: string,
  chatId: string,
  fresh: boolean,
  signal: AbortSignal,
  deps: { fetch?: typeof fetch; wait?: typeof wait } = {},
): Promise<SessionUrls> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await (deps.fetch ?? fetch)(chatRoute(workspaceId, chatId, `session${fresh || attempt > 0 ? "?fresh=1" : ""}`), {
        method: "POST",
        signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
        const code = body?.code ?? null;
        throw new AttachError(
          body?.error ?? "Couldn't reach this session's box.",
          code,
          code === BOX_RESTORE_FAILED || (!code && !(response.status === 500 && body?.error) && UNANSWERED_STATUSES.has(response.status)),
        );
      }
      const parsed = SessionUrls.safeParse(await response.json());
      if (!parsed.success) throw new Error("Malformed session response from server");
      return parsed.data;
    } catch (error) {
      signal.throwIfAborted();
      const retryable = retryableAttachFailure(error);
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) throw error;
      await (deps.wait ?? wait)(delay, signal);
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
