/**
 * Onboarding's rules, apart from its screens (components/onboarding), so they
 * test on their own.
 */

import { PLANS } from "@/lib/billing/plans";
import type { RepositoryListing } from "@/lib/github/listing";
import type { AgentChoices, AgentMethod, AgentPick, AgentStatus, OnboardingProgress, OnboardingStep } from "@/lib/onboarding/types";

/** The repositories a user picks from, most recently pushed first. */
export function sortRepositories(repositories: RepositoryListing[]): RepositoryListing[] {
  return [...repositories].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
}

/** The repositories matching `query`, by owner/name or description. */
export function filterRepositories(repositories: RepositoryListing[], query: string): RepositoryListing[] {
  const q = query.trim().toLowerCase();
  if (!q) return repositories;
  return repositories.filter(
    (r) => r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
  );
}

/** What one credit is worth, in USD: the Free plan's allowance shown as
 *  credits (1 credit = 5¢). */
export const USD_PER_CREDIT = 0.05;

/** What a new account gets of Outrunner's models, as the Free plan says
 *  (lib/billing/plans.ts), in credits: "100 free credits". */
export function freeModelsOffer(): string {
  const { usd, per } = PLANS.free.models;
  const credits = Math.round(usd / USD_PER_CREDIT);
  return per === "once" ? `${credits} free credits` : `${credits} free credits a month`;
}

/** The origin the command shows before the browser's is known (the server
 *  render of the onboarding page). Matches the CLI's DefaultURL
 *  (runtime-agent/internal/cli/main.go). */
export const CLI_DEFAULT_URL = "https://app.outrunner.sh";

/** The command that connects a Claude subscription from the terminal, run
 *  with `runner` (`npx`, `pnpm dlx`…), for the app at `origin`. It's
 *  `outrunner claude`, not the bare command: the page showing it is open and
 *  moves on by itself, so the CLI mustn't open onboarding in another tab. The
 *  app is always named with --url, even the default: OUTRUNNER_URL in the
 *  user's shell would otherwise win, the token would be saved to that app, and
 *  this page would never see it. So is the account, with --account, when it's
 *  known: a terminal still signed in to another account signs in again,
 *  rather than save the token where this page isn't looking. */
export function connectClaudeCommand(runner: string, origin: string, account?: string): string {
  return `${runner} outrunner@latest --url ${origin}${account ? ` --account ${account}` : ""} claude`;
}

const STEPS: readonly OnboardingStep[] = ["agent", "repos", "start"];
const PICKS: readonly AgentPick[] = ["claude", "codex", "outrunner", "codex-outrunner"];

/** Saved progress as read back from storage, or null when it isn't any:
 *  storage is the browser's, anyone's to write. */
export function parseProgress(raw: unknown): OnboardingProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const { step, done, runOn } = raw as Record<string, unknown>;
  if (!STEPS.includes(step as OnboardingStep) || !PICKS.includes(runOn as AgentPick) || !Array.isArray(done)) return null;
  return { step: step as OnboardingStep, done: STEPS.filter((s) => done.includes(s)), runOn: runOn as AgentPick };
}

/** The agent of the user's own that's connected already, and how: the way
 *  they picked in Settings → Providers when it's connected, or else a Claude
 *  subscription, then an Anthropic key, then an OpenAI key. `chosen` says
 *  it's their pick already, so nothing needs saving. Null when none is. */
export function connectedAgent(
  status: AgentStatus,
  choices: AgentChoices,
): { agent: "claude" | "codex"; method: AgentMethod; chosen: boolean } | null {
  const ready = [
    status.claude.subscription && { agent: "claude" as const, method: "subscription" as const },
    status.claude.apiKey && { agent: "claude" as const, method: "api-key" as const },
    status.codex.apiKey && { agent: "codex" as const, method: "api-key" as const },
  ].filter((way) => way !== false);
  const picked = ready.find((way) => choices[way.agent] === way.method);
  if (picked) return { ...picked, chosen: true };
  return ready[0] ? { ...ready[0], chosen: false } : null;
}

/** Whether the user's own `agent` can run a session as things are now. */
function canRun(agent: "claude" | "codex", status: AgentStatus): boolean {
  return agent === "claude" ? status.claude.subscription || status.claude.apiKey : status.codex.apiKey;
}

/**
 * Where onboarding opens: where it was left in this browser, and past the
 * Agent step when that's not done but an agent is connected already (from
 * `npx outrunner … claude` in the terminal, say, seen from a tab the CLI
 * opened), on that agent. `save` is the way sessions sign in to save then,
 * when it isn't the user's pick already; with `choices` unknown (null) the
 * step isn't passed, so no pick is made blind.
 *
 * An Agent step done on the user's own agent that can't run now (its key
 * removed, say) is the Agent step again, not a Start that fails. Start
 * needs the repositories just picked, which aren't kept, so it opens on
 * Repositories, their step, ticked as they were. A user who went back to
 * the Agent step (it's done) stays on it.
 */
export function resumeAt(
  saved: OnboardingProgress | null,
  status: AgentStatus,
  choices: AgentChoices | null,
): OnboardingProgress & { save?: { agent: "claude" | "codex"; method: AgentMethod } } {
  let at: OnboardingProgress = saved ?? { step: "agent", done: [], runOn: "outrunner" };
  if (at.done.includes("agent") && (at.runOn === "claude" || at.runOn === "codex") && !canRun(at.runOn, status)) {
    at = { step: "agent", done: at.done.filter((step) => step !== "agent"), runOn: "outrunner" };
  }
  if (at.step === "start") return { ...at, step: "repos" };
  if (at.step !== "agent" || at.done.includes("agent") || !choices) return at;
  const connected = connectedAgent(status, choices);
  if (!connected) return at;
  const { agent, method, chosen } = connected;
  return { step: "repos", done: [...at.done, "agent"], runOn: agent, ...(!chosen && { save: { agent, method } }) };
}
