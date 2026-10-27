/**
 * Installing the Outrunner GitHub App from the Automations page, and linking
 * the installation to the org the admin started from.
 *
 * The round trip: `/api/github/app/install?org=<id>` (an admin of that org)
 * keeps the org and a random nonce in a short-lived cookie and sends them to
 * GitHub with the nonce as `state`. GitHub sends them back to the setup URL,
 * `/api/github/app/setup?installation_id=…&setup_action=…&state=…`, which
 * links the installation only when `state` matches the cookie: a setup link
 * made by someone else, or opened in another browser, links nothing.
 *
 * Nor does editing `installation_id` in that URL link someone else's: the
 * admin must control the installation's account (userControlsInstallation
 * in lib/github/app.ts).
 */

import type { OrgRole } from "@/lib/orgs/active";
import { installationId, type Installation } from "@/lib/github/installation";
import { isUuid } from "@/lib/ids";

export const AUTOMATIONS_PATH = "/automations";

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

/** Why the Automations page was sent back to without a link; the page says. */
export type SetupProblem =
  | "not_configured"
  | "requested"
  | "start_here"
  | "not_admin"
  | "not_found"
  | "not_yours"
  | "github"
  | "failed";

export const SETUP_MESSAGES: Record<SetupProblem, string> = {
  not_configured: "The Outrunner GitHub App isn't set up on this deployment yet.",
  requested:
    "GitHub sent your request to install the app to the account's owners. Once one of them approves, install it from here again to link it.",
  start_here: "Couldn't link that installation. Start from Install on GitHub below, in this browser.",
  not_admin: "Only the org's admins can link the GitHub App.",
  not_found: "GitHub has no such installation of the Outrunner app. Install it again.",
  not_yours:
    "You can link the app only where you installed it: your own GitHub account, an organization you own, or repositories you're an admin of.",
  github: "Couldn't reach GitHub to check the installation. Try again.",
  failed: "Couldn't link the installation. Try again.",
};

export function setupProblem(value: unknown): SetupProblem | null {
  return typeof value === "string" && Object.hasOwn(SETUP_MESSAGES, value) ? (value as SetupProblem) : null;
}

export type SetupDeps = {
  memberRole(orgId: string, userId: string): Promise<OrgRole | null>;
  getInstallation(id: number): Promise<Installation | null>;
  /** Whether the user controls the installation's GitHub account. */
  controlsInstallation(installation: Installation, userId: string): Promise<boolean>;
  linkInstallation(input: { orgId: string; installation: Installation; linkedBy: string }): Promise<void>;
};

/** Where the setup URL sends the admin: the Automations page, saying what
 *  was linked or what went wrong. */
export async function completeSetup(
  input: { userId: string; params: URLSearchParams; cookie: string | undefined },
  deps: SetupDeps,
): Promise<string> {
  const back = (query: Record<string, string>) => `${AUTOMATIONS_PATH}?${new URLSearchParams(query)}`;
  const { params } = input;
  // An account member without rights to install asked its owners instead:
  // there's nothing to link until one of them approves.
  if (params.get("setup_action") === "request") return back({ problem: "requested" });

  const id = installationId(params.get("installation_id"));
  const started = readInstallCookie(input.cookie);
  if (id === null || !started || params.get("state") !== started.nonce) {
    // Repositories changed on GitHub ("Redirect on update"): the webhook keeps
    // that, so there's nothing to link and nothing went wrong.
    if (params.get("setup_action") === "update") return AUTOMATIONS_PATH;
    return back({ problem: "start_here" });
  }

  try {
    if ((await deps.memberRole(started.orgId, input.userId)) !== "admin") return back({ problem: "not_admin" });
  } catch (error) {
    console.error("Could not check the admin linking a GitHub App installation", error);
    return back({ problem: "failed" });
  }

  let installation: Installation | null;
  try {
    installation = await deps.getInstallation(id);
    if (installation && !(await deps.controlsInstallation(installation, input.userId))) {
      return back({ problem: "not_yours" });
    }
  } catch (error) {
    console.error("Could not read the GitHub App installation being linked", error);
    return back({ problem: "github" });
  }
  if (!installation) return back({ problem: "not_found" });

  try {
    await deps.linkInstallation({ orgId: started.orgId, installation, linkedBy: input.userId });
  } catch (error) {
    console.error("Could not link a GitHub App installation", error);
    return back({ problem: "failed" });
  }
  return back({ linked: String(installation.installationId) });
}
