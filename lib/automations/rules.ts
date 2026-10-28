/**
 * What an automation is, and what may be saved as one: the checks the
 * Automations routes run on what the page sends.
 */

import { isUuid } from "@/lib/ids";

export const AUTOMATION_TRIGGERS = ["pull_request.opened", "pull_request.synchronize"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

/** Each trigger as the page names it. */
export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  "pull_request.opened": "PR opened",
  "pull_request.synchronize": "New commits on a PR",
};

export const NAME_MAX = 80;
export const PROMPT_MAX = 20_000;
/** Enough for any one workflow; a list past it is a mistake. */
export const REPOS_MAX = 50;

/** A repository an automation can run on: one of the org's projects. */
export type AutomationRepo = { projectId: string; fullName: string };

export type Automation = {
  id: string;
  name: string;
  template: string | null;
  prompt: string;
  triggers: AutomationTrigger[];
  repos: AutomationRepo[];
  enabled: boolean;
  /** Who it runs as: whoever last set what it does (its prompt, triggers
   *  or repositories). Null once they've left. */
  runsAs: { id: string; login: string } | null;
  createdAt: string;
};

/** What's saved: everything the page sets. */
export type AutomationInput = {
  name: string;
  template: string | null;
  prompt: string;
  triggers: AutomationTrigger[];
  projectIds: string[];
  enabled: boolean;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isTrigger(value: unknown): value is AutomationTrigger {
  return (AUTOMATION_TRIGGERS as readonly unknown[]).includes(value);
}

/**
 * The fields of `body` that are present, checked: a PATCH sends some, a POST
 * all (`full`). Names and prompts are trimmed; triggers and repositories
 * deduplicated.
 */
export function parseAutomationInput(body: unknown, { full }: { full: true }): Parsed<AutomationInput>;
export function parseAutomationInput(body: unknown, { full }: { full: false }): Parsed<Partial<AutomationInput>>;
export function parseAutomationInput(body: unknown, { full }: { full: boolean }): Parsed<Partial<AutomationInput>> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the automation as JSON." };
  const b = body as Record<string, unknown>;
  const value: Partial<AutomationInput> = {};

  if (full || b.name !== undefined) {
    const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
    if (name.length < 1 || name.length > NAME_MAX) {
      return { ok: false, error: `Give it a name of 1 to ${NAME_MAX} characters.` };
    }
    value.name = name;
  }
  if (full || b.template !== undefined) {
    if (b.template !== undefined && b.template !== null && typeof b.template !== "string") {
      return { ok: false, error: "That isn't a template." };
    }
    value.template = typeof b.template === "string" && b.template !== "" ? b.template : null;
  }
  if (full || b.prompt !== undefined) {
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (prompt.length < 1) return { ok: false, error: "Write the prompt the session runs." };
    if (prompt.length > PROMPT_MAX) return { ok: false, error: `Keep the prompt under ${PROMPT_MAX} characters.` };
    value.prompt = prompt;
  }
  if (full || b.triggers !== undefined) {
    if (!Array.isArray(b.triggers) || !b.triggers.every(isTrigger) || b.triggers.length === 0) {
      return { ok: false, error: "Pick at least one trigger." };
    }
    value.triggers = AUTOMATION_TRIGGERS.filter((t) => (b.triggers as unknown[]).includes(t));
  }
  if (full || b.projectIds !== undefined) {
    if (!Array.isArray(b.projectIds) || !b.projectIds.every((id) => typeof id === "string" && isUuid(id))) {
      return { ok: false, error: "Those aren't repositories of this org." };
    }
    const ids = [...new Set(b.projectIds as string[])];
    if (ids.length === 0) return { ok: false, error: "Pick at least one repository." };
    if (ids.length > REPOS_MAX) return { ok: false, error: `Pick at most ${REPOS_MAX} repositories.` };
    value.projectIds = ids;
  }
  if (full || b.enabled !== undefined) {
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") return { ok: false, error: "Enabled is on or off." };
    value.enabled = b.enabled ?? true;
  }
  return { ok: true, value };
}

/** Whether the Outrunner GitHub App can act on a repository, so an
 *  automation on it can post: "unknown" when GitHub couldn't be asked. */
export type AppCoverage = "installed" | "not_installed" | "suspended" | "unknown";

/**
 * The app's coverage of each repository (`owner/name`), from the org's
 * installations: an installation on all of an account's repositories covers
 * every repository that account owns; one on selected repositories covers
 * those listed (`selected`, keyed by installation id; missing when the list
 * couldn't be read, and not `complete` when GitHub had more than was read:
 * then a repository missing from it is "unknown", not "not_installed").
 */
export function appCoverage(
  fullNames: readonly string[],
  installations: readonly {
    installationId: number;
    accountLogin: string;
    repositorySelection: "all" | "selected";
    suspendedAt: string | null;
  }[],
  selected: ReadonlyMap<number, { names: ReadonlySet<string>; complete: boolean }>,
): Map<string, AppCoverage> {
  const result = new Map<string, AppCoverage>();
  for (const fullName of fullNames) {
    const owner = fullName.split("/")[0]?.toLowerCase();
    let coverage: AppCoverage = "not_installed";
    for (const installation of installations) {
      if (installation.accountLogin.toLowerCase() !== owner) continue;
      let covers: boolean | null;
      if (installation.repositorySelection === "all") covers = true;
      else {
        const listed = selected.get(installation.installationId);
        covers = !listed ? null : listed.names.has(fullName.toLowerCase()) ? true : listed.complete ? false : null;
      }
      if (covers === true) {
        coverage = installation.suspendedAt ? "suspended" : "installed";
        if (coverage === "installed") break;
      } else if (covers === null && coverage === "not_installed") {
        coverage = "unknown";
      }
    }
    result.set(fullName, coverage);
  }
  return result;
}
