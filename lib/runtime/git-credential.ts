/**
 * How a box asks Outrunner for a GitHub token (app/api/runtime/git-credential):
 * its agent signs the request with the secret the control plane booted it
 * with (RUNTIME_AGENT_SECRET), naming its sandbox, so Outrunner knows which
 * Runtime Computer, and so whose session, is asking. The agent's side is
 * runtime-agent/internal/gitcred.
 *
 * The signature covers the sandbox, the time and the body; a request more
 * than five minutes from Outrunner's clock is refused, so one overheard can't
 * be played again later.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a request's time may be from the server's. */
export const GIT_CREDENTIAL_WINDOW_SECONDS = 5 * 60;

/** The `X-Outrunner-Signature` of a request: HMAC-SHA256 under the agent's
 *  secret of the purpose, sandbox, time and body, a line each. */
export function gitCredentialSignature(secret: string, sandboxId: string, timestamp: string, body: string): string {
  const mac = createHmac("sha256", secret).update(`git-credential\n${sandboxId}\n${timestamp}\n${body}`).digest("hex");
  return `sha256=${mac}`;
}

/** Whether a request was signed with `secret`, and recently. */
export function gitCredentialRequestValid(
  secret: string,
  request: { sandboxId: string; timestamp: string | null; signature: string | null; body: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { timestamp, signature } = request;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > GIT_CREDENTIAL_WINDOW_SECONDS) return false;
  const expected = Buffer.from(gitCredentialSignature(secret, request.sandboxId, timestamp, request.body));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The environment a box's agent asks with: which sandbox it is, and where
 *  Outrunner is. None without a public address the box can reach. */
export function gitCredentialEnvironment(sandboxId: string, appUrl: string | undefined): Record<string, string> {
  if (!appUrl || !/^https:\/\//.test(appUrl)) return {};
  return { RUNTIME_SANDBOX_ID: sandboxId, OUTRUNNER_APP_URL: appUrl.replace(/\/+$/, "") };
}
