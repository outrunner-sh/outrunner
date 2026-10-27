/**
 * A GitHub App installation as Outrunner keeps and shows it. Kept apart from
 * lib/github/app.ts, which signs with the app's private key, so Settings →
 * Code review's client component can import it.
 */

export type InstallationAccountType = "User" | "Organization";

/** Where an installation's repositories are picked on GitHub. */
export function installationSettingsUrl(
  installation: { installationId: number; accountLogin: string; accountType: InstallationAccountType },
): string {
  const id = installation.installationId;
  return installation.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

/** An installation id as GitHub sends it in a URL: a positive integer. */
export function installationId(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,15}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** An installation, as Outrunner keeps it. */
export type Installation = {
  installationId: number;
  accountLogin: string;
  accountType: InstallationAccountType;
  /** "all" the account's repositories, or "selected" ones. */
  repositorySelection: "all" | "selected";
  suspended: boolean;
};

/** An installation record from GitHub, or null if it lacks what we keep. */
export function normalizeInstallation(record: unknown): Installation | null {
  const r = (record ?? {}) as {
    id?: unknown;
    account?: { login?: unknown; type?: unknown } | null;
    repository_selection?: unknown;
    suspended_at?: unknown;
  };
  const id = installationId(r.id);
  const login = r.account?.login;
  const type = r.account?.type;
  if (id === null || typeof login !== "string" || login === "") return null;
  if (type !== "User" && type !== "Organization") return null;
  return {
    installationId: id,
    accountLogin: login,
    accountType: type,
    repositorySelection: r.repository_selection === "all" ? "all" : "selected",
    suspended: typeof r.suspended_at === "string",
  };
}
