/**
 * Receiving a Jira webhook: its token before anything else (nothing unsigned is even
 * parsed), then the event. Jira retries on a 408, 409, 425, 429, 5xx or a timeout, up to five
 * times over about an hour, so a failure answers 5xx; anything else is answered 200, since
 * a retry wouldn't change it. Retries keep their identifier, which is what dedupes them.
 */

import { verifyJiraWebhookToken } from "@/lib/trackers/jira";
import { TokenUnavailableError } from "@/lib/trackers/tokens";

/** A body Jira means for us is far below this; anything bigger isn't worth reading. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type JiraReceipt = { status: 200 | 400 | 401 | 404 | 413 | 500 | 503; body: Record<string, unknown> };

export type JiraWebhookInput = {
  body: Uint8Array;
  authorization: string | null;
  identifier: string | null;
  /** The app's client secret; null when Jira isn't set up here. */
  secret: string | null;
  now?: number;
};

export async function receiveJiraWebhook(
  input: JiraWebhookInput,
  handle: (event: { identifier: string | null; payload: unknown }) => Promise<{ handled: boolean; reason?: string }>,
): Promise<JiraReceipt> {
  if (!input.secret) return { status: 404, body: { error: "Jira isn't set up here." } };
  if (input.body.byteLength > MAX_BODY_BYTES) return { status: 413, body: { error: "Too large." } };
  if (!verifyJiraWebhookToken(input.authorization, input.secret, input.now)) return { status: 401, body: { error: "Bad token." } };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(input.body).toString("utf8"));
  } catch {
    return { status: 400, body: { error: "Not JSON." } };
  }
  try {
    return { status: 200, body: await handle({ identifier: input.identifier, payload }) };
  } catch (error) {
    // Someone else's refresh is taking too long: Jira can try again soon.
    if (error instanceof TokenUnavailableError) return { status: 503, body: { error: "Try again." } };
    console.error("Jira webhook failed", error);
    return { status: 500, body: { error: "Failed." } };
  }
}
