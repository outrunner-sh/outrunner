/**
 * How a session's agent asks Outrunner for a preview from its box
 * (app/api/runtime/previews): as it asks for a GitHub token
 * (lib/runtime/git-credential.ts), its request signed with the box's
 * secret, naming its sandbox, but for this purpose alone, so a signature
 * for one is never good for the other. The agent's side is
 * runtime-agent/internal/preview.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { GIT_CREDENTIAL_WINDOW_SECONDS } from "@/lib/runtime/git-credential";

/** The `X-Outrunner-Signature` of a preview request. */
export function previewRequestSignature(secret: string, sandboxId: string, timestamp: string, body: string): string {
  const mac = createHmac("sha256", secret).update(`preview\n${sandboxId}\n${timestamp}\n${body}`).digest("hex");
  return `sha256=${mac}`;
}

/** Whether a preview request was signed with `secret`, and recently. */
export function previewRequestValid(
  secret: string,
  request: { sandboxId: string; timestamp: string | null; signature: string | null; body: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { timestamp, signature } = request;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > GIT_CREDENTIAL_WINDOW_SECONDS) return false;
  const expected = Buffer.from(previewRequestSignature(secret, request.sandboxId, timestamp, request.body));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
