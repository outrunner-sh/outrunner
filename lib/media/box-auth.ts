/**
 * How a box's agent proves an upload is its own (app/api/runtime/media): as
 * it asks for a GitHub token (lib/runtime/git-credential.ts), it signs the
 * request with the secret the control plane booted it with, naming its
 * sandbox. The purpose is part of what is signed, so a request signed for
 * one route can't be replayed at another. The agent's side is
 * runtime-agent/internal/media.
 *
 * Only the agent holds the secret: the sessions' environment never has it,
 * so a session uploads through the agent (its upload_media tool, or the
 * `outrunner media` command), and the agent says which session it is for.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { GIT_CREDENTIAL_WINDOW_SECONDS } from "@/lib/runtime/git-credential";

export type MediaRoute = "media-upload" | "media-complete";
type BoxPurpose = MediaRoute | "memory-scale";

/** The `X-Outrunner-Signature` of a media request: HMAC-SHA256 under the
 *  agent's secret of the purpose, sandbox, time and body, a line each. */
export function mediaRequestSignature(
  secret: string,
  purpose: BoxPurpose,
  sandboxId: string,
  timestamp: string,
  body: string,
): string {
  const mac = createHmac("sha256", secret).update(`${purpose}\n${sandboxId}\n${timestamp}\n${body}`).digest("hex");
  return `sha256=${mac}`;
}

/** Whether a request was signed with `secret` for `purpose`, and recently:
 *  within the window a GitHub token's request has. */
export function mediaRequestValid(
  secret: string,
  purpose: BoxPurpose,
  request: { sandboxId: string; timestamp: string | null; signature: string | null; body: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { timestamp, signature } = request;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > GIT_CREDENTIAL_WINDOW_SECONDS) return false;
  const expected = Buffer.from(mediaRequestSignature(secret, purpose, request.sandboxId, timestamp, request.body));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
