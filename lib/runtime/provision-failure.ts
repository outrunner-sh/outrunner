import { makeRedactor } from "@/lib/runtime/redact";
import type { ProvisionPhase } from "@/lib/runtime/types";

/**
 * What a session that didn't start tells its user: the step it stopped at and
 * the error that stopped it. The raw error used to stay in the server log
 * alone, so the page said only "Provisioning failed" and the cause took a log
 * search to find.
 *
 * Errors from a box, git, or a provider can echo what they were handed, so the
 * session's own secrets are cut out, then anything shaped like a credential.
 */

/** Longest error text the page shows; the server log keeps all of it. */
export const MAX_DETAIL_CHARS = 300;

const STEP: Record<ProvisionPhase, string> = {
  allocate: "provisioning the sandbox",
  clone: "cloning the repository",
  worktree: "creating the workspace",
  secrets: "configuring the session",
  install: "installing dependencies",
  health_check: "starting the agent",
  claude_ready: "starting the agent",
};

/** Credentials by their shape, for any the session didn't know it held. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  // Userinfo in a URL: https://x-access-token:<token>@github.com/...
  /(?<=:\/\/)[^\s/@]+@/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

/** What GitHub says, through git, when it won't take the token it was given:
 *  revoked, expired, or never one it knew. Not git asking for a username,
 *  which is a clone with no token at all. */
const GITHUB_REFUSED = /Invalid username or token|Authentication failed for 'https:\/\/github\.com/i;

/** A session's setup that GitHub refused: only signing in again fixes it. */
export const GITHUB_RECONNECT_MESSAGE =
  "GitHub didn't accept your connection, so the repository couldn't be cloned. Reconnect GitHub in Settings → Connections, then start a new session.";

/** What Daytona says when the account is out of room for another box: its
 *  total disk, CPU or memory, or its sandbox count. And Neev, when the
 *  account's prepaid credits won't cover another box for an hour. */
const SANDBOX_CAPACITY =
  /\b(?:total )?(?:disk|cpu|memory|sandbox(?:es)?) (?:limit|quota) exceeded\b|\bTotal (?:disk|CPU|memory) limit\b|\bcredits are too low\b/i;

/** Outrunner's sandbox account being full: nothing the user can do about it
 *  there, so never Daytona's own words, which name an org and a dashboard
 *  that are Outrunner's, not theirs. */
export const PLATFORM_CAPACITY_MESSAGE =
  "Outrunner's cloud has no room for another sandbox right now. This isn't a problem with your account; try again in a few minutes, and contact support if it keeps happening.";

export function provisionFailureMessage(
  error: unknown,
  phase: ProvisionPhase | null,
  secrets: readonly (string | undefined | null)[],
  /** The box is on Outrunner's sandbox account, not one of the user's own. */
  platformBox = false,
): string {
  const step = phase ? ` while ${STEP[phase]}` : "";
  const detail = errorText(error);
  if (GITHUB_REFUSED.test(detail)) return GITHUB_RECONNECT_MESSAGE;
  // Only where a box is made or started: a clone or install that runs out of
  // room inside the box ("Disk quota exceeded" from git) is its own cause.
  if (platformBox && (phase === null || phase === "allocate") && SANDBOX_CAPACITY.test(detail)) return PLATFORM_CAPACITY_MESSAGE;
  if (!detail) return `Setup failed${step}. Start a new session to try again.`;
  return `Setup failed${step}: ${truncate(redact(detail, secrets))}`;
}

/** An Error's message, or a Supabase error's: those are plain objects. */
function errorText(error: unknown): string {
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "";
  return message.replace(/\s+/g, " ").trim();
}

function redact(text: string, secrets: readonly (string | undefined | null)[]): string {
  const known = makeRedactor(secrets)(text);
  return CREDENTIAL_SHAPES.reduce(
    (acc, shape) => acc.replace(shape, (match) => (match.endsWith("@") ? "***@" : "***")),
    known,
  );
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…` : text;
}

/**
 * A stored failure message as the page shows it: a sentence first,
 * and what the box or git said, if anything, behind Details.
 */
export function failureParts(message: string): { summary: string; detail: string | null } {
  const match = /^Setup failed( while [^:]+)?: ([\s\S]+)$/.exec(message);
  if (!match) return { summary: message, detail: null };
  return { summary: `Setup failed${match[1] ?? ""}. Try again to start a fresh session.`, detail: match[2] };
}
