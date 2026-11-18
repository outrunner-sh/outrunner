/**
 * Onboarding's rules, apart from its screens (components/onboarding), so they
 * test on their own.
 */

import type { AgentId } from "@/lib/agents/registry";
import { PLANS } from "@/lib/billing/plans";
import { repositoryKey, type CodeProvider } from "@/lib/code-providers/repository";
import type { RepositoryListing } from "@/lib/github/listing";
import type { AgentChoices, AgentMethod, AgentPick, AgentStatus, OnboardingProgress, OnboardingStep } from "@/lib/onboarding/types";
import {
  CLAUDE_DEFAULT_MODEL,
  CODEX_MODELS,
  DEFAULT_EFFORT,
  type Effort,
  OUTRUNNER_MODELS,
  type SessionModel,
} from "@/lib/runtime/session-models";

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

/** Under the repository picker: the new picks, and apart from them those
 *  connected already (some may not be in the list at all). */
export function pickSummary(picked: number, connected: number): string {
  if (picked === 0 && connected === 0) return "Pick at least one";
  const already = `${connected} already connected`;
  if (picked === 0) return already;
  return connected === 0 ? `${picked} picked` : `${picked} picked · ${already}`;
}

/** In place of the picker when the org has repositories connected already:
 *  how many, and a few of them by name (`names`, those the listing has, in
 *  its order; `total` counts those it doesn't too). */
export function connectedSummary(names: string[], total: number): { title: string; detail: string } {
  const title = `${total} ${total === 1 ? "repository" : "repositories"} connected`;
  const few = names.slice(0, 3);
  const rest = total - few.length;
  if (few.length === 0) return { title, detail: "" };
  if (rest > 0) return { title, detail: `${few.join(", ")} and ${rest} more` };
  return { title, detail: few.length === 1 ? few[0] : `${few.slice(0, -1).join(", ")} and ${few.at(-1)}` };
}

/** The projects of the repositories picked, in the order they were ticked:
 *  the first session starts on the first. `projects` may hold others. */
export function pickedProjects<P extends { githubRepoId: number | null; provider?: CodeProvider; repositoryId?: number }>(
  projects: P[],
  ids: number[],
  provider: CodeProvider,
): P[] {
  const byKey = new Map(projects.map((project) => [repositoryKey(project), project]));
  return ids.flatMap((id) => byKey.get(`${provider}:${id}`) ?? []);
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

const STEPS: readonly OnboardingStep[] = ["agent", "repos"];
const PICKS: readonly AgentPick[] = ["claude", "codex", "outrunner", "codex-outrunner"];

/** An agent pick from anywhere (a URL's `?start=`, storage); undefined for
 *  anything else. */
export function parseAgentPick(raw: unknown): AgentPick | undefined {
  return PICKS.find((pick) => pick === raw);
}

/** Saved progress as read back from storage, or null when it isn't any:
 *  storage is the browser's, anyone's to write. A Start step saved before
 *  there was none is its Repositories step, where onboarding now ends. */
export function parseProgress(raw: unknown): OnboardingProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const { step: savedStep, done, runOn } = raw as Record<string, unknown>;
  const step = savedStep === "start" ? "repos" : savedStep;
  const pick = parseAgentPick(runOn);
  if (!STEPS.includes(step as OnboardingStep) || !pick || !Array.isArray(done)) return null;
  return { step: step as OnboardingStep, done: STEPS.filter((s) => done.includes(s)), runOn: pick };
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
 * when it isn't the user's pick already. With `status` or `choices` unknown
 * (null: they couldn't be read) the step isn't passed, so no pick is made
 * blind.
 *
 * An Agent step done on the user's own agent that can't run now (its key
 * removed, say) is the Agent step again, not a new session that fails; a
 * status that couldn't be read says nothing of that, so the progress stands.
 * A user who went back to the Agent step (it's done) stays on it.
 */
export function resumeAt(
  saved: OnboardingProgress | null,
  status: AgentStatus | null,
  choices: AgentChoices | null,
): OnboardingProgress & { save?: { agent: "claude" | "codex"; method: AgentMethod } } {
  let at: OnboardingProgress = saved ?? { step: "agent", done: [], runOn: "outrunner" };
  if (status && at.done.includes("agent") && (at.runOn === "claude" || at.runOn === "codex") && !canRun(at.runOn, status)) {
    at = { step: "agent", done: at.done.filter((step) => step !== "agent"), runOn: "outrunner" };
  }
  if (at.step !== "agent" || at.done.includes("agent") || !status || !choices) return at;
  const connected = connectedAgent(status, choices);
  if (!connected) return at;
  const { agent, method, chosen } = connected;
  return { step: "repos", done: [...at.done, "agent"], runOn: agent, ...(!chosen && { save: { agent, method } }) };
}

/** What the new-session form starts on after onboarding: its model, the
 *  effort it runs at (null: the model's own), and the agent where it isn't
 *  the model's default (Codex on Outrunner's models). */
export type StartingPick = { model: SessionModel; effort: Effort | null; agent?: AgentId };

/** The model a first session starts on, by the agent picked: the user's own
 *  Claude or Codex, at DEFAULT_EFFORT, as the new-session screen starts them;
 *  or Outrunner's first model, in Codex where that is the pick (Claude Code
 *  would be its default). Always named: with no model, a user whose Claude is
 *  connected would start on it, not on the Outrunner's models they picked. */
export function startingPick(pick: AgentPick): StartingPick {
  if (pick === "claude") return { model: CLAUDE_DEFAULT_MODEL, effort: DEFAULT_EFFORT };
  if (pick === "codex") return { model: CODEX_MODELS[0], effort: DEFAULT_EFFORT };
  const outrunner = { model: OUTRUNNER_MODELS[0], effort: null };
  return pick === "codex-outrunner" ? { ...outrunner, agent: "codex" } : outrunner;
}

/** Where onboarding ends: the new-session screen, on the first repository
 *  picked (none: the form's own choice), the composer focused, starting on
 *  the agent picked (`?start=`, read by components/new-session-route.tsx). */
export function newSessionAfterOnboarding(projectId: string | undefined, runOn: AgentPick): string {
  const query = new URLSearchParams({ ...(projectId && { project: projectId }), focus: "composer", start: runOn });
  return `/new?${query}`;
}
