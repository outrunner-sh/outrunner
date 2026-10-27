/**
 * Installing the Outrunner GitHub App from Settings → Code review, and linking
 * the installation to the org the admin started from.
 *
 * The round trip: `/api/github/app/install?org=<id>` (an admin of that org)
 * keeps the org and a random nonce in a short-lived cookie and sends them to
 * GitHub with the nonce as `state`. GitHub sends them back to the setup URL,
 * `/api/github/app/setup?installation_id=…&setup_action=…&state=…`, which
 * links the installation only when `state` matches the cookie: a setup link
 * made by someone else, or opened in another browser, links nothing.
 *
 * Linking someone else's installation id gains nothing either: the app acts
 * only on repositories the org has connected, which takes the user's own
 * GitHub access to each.
 */

import type { OrgRole } from "@/lib/orgs/active";
import { installationId, type Installation } from "@/lib/github/installation";
import { isUuid } from "@/lib/ids";

export const CODE_REVIEW_PATH = "/settings/code-review";

export const INSTALL_COOKIE = "outrunner_github_install";
export const INSTALL_COOKIE_PATH = "/api/github/app";
/** Long enough to pick repositories on GitHub; short enough not to linger. */
export const INSTALL_COOKIE_SECONDS = 30 * 60;

/** What the install cookie holds: the org and the nonce sent as `state`. */
export function installCookieValue(orgId: string, nonce: string): string {
  return `${orgId}.${nonce}`;
}

export function readInstallCookie(value: string | undefined): { orgId: string; nonce: string } | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  const orgId = value.slice(0, dot);
  const nonce = value.slice(dot + 1);
  return dot > 0 && isUuid(orgId) && /^[A-Za-z0-9_-]{16,}$/.test(nonce) ? { orgId, nonce } : null;
}

/** Why Settings → Code review was sent back without a link; the page says. */
export type SetupProblem =
  | "not_configured"
  | "requested"
  | "start_here"
  | "not_admin"
  | "not_found"
  | "github";

export const SETUP_MESSAGES: Record<SetupProblem, string> = {
  not_configured: "The Outrunner GitHub App isn't set up on this deployment yet.",
  requested:
    "GitHub sent your request to install the app to the account's owners. Once one of them approves, install it from here again to link it.",
  start_here: "Couldn't link that installation. Start from Install on GitHub below, in this browser.",
  not_admin: "Only the org's admins can link the GitHub App.",
  not_found: "GitHub has no such installation of the Outrunner app. Install it again.",
  github: "Couldn't reach GitHub to check the installation. Try again.",
};

export function setupProblem(value: unknown): SetupProblem | null {
  return typeof value === "string" && Object.hasOwn(SETUP_MESSAGES, value) ? (value as SetupProblem) : null;
}

export type SetupDeps = {
  memberRole(orgId: string, userId: string): Promise<OrgRole | null>;
  getInstallation(id: number): Promise<Installation | null>;
  linkInstallation(input: { orgId: string; installation: Installation; linkedBy: string }): Promise<void>;
};

/** Where the setup URL sends the admin: Settings → Code review, saying what
 *  was linked or what went wrong. */
export async function completeSetup(
  input: { userId: string; params: URLSearchParams; cookie: string | undefined },
  deps: SetupDeps,
): Promise<string> {
  const back = (query: Record<string, string>) => `${CODE_REVIEW_PATH}?${new URLSearchParams(query)}`;
  const { params } = input;
  // An account member without rights to install asked its owners instead:
  // there's nothing to link until one of them approves.
  if (params.get("setup_action") === "request") return back({ problem: "requested" });

  const id = installationId(params.get("installation_id"));
  const started = readInstallCookie(input.cookie);
  if (id === null || !started || params.get("state") !== started.nonce) {
    // Repositories changed on GitHub ("Redirect on update"): the webhook keeps
    // that, so there's nothing to link and nothing went wrong.
    if (params.get("setup_action") === "update") return CODE_REVIEW_PATH;
    return back({ problem: "start_here" });
  }

  if ((await deps.memberRole(started.orgId, input.userId)) !== "admin") return back({ problem: "not_admin" });

  let installation: Installation | null;
  try {
    installation = await deps.getInstallation(id);
  } catch (error) {
    console.error("Could not read the GitHub App installation being linked", error);
    return back({ problem: "github" });
  }
  if (!installation) return back({ problem: "not_found" });

  await deps.linkInstallation({ orgId: started.orgId, installation, linkedBy: input.userId });
  return back({ linked: installation.accountLogin });
}
