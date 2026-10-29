/**
 * Onboarding's rules, apart from its screens (components/onboarding), so they
 * test on their own.
 */

import type { AgentId } from "@/lib/agents/registry";
import { PLANS } from "@/lib/billing/plans";
import type { RepositoryListing } from "@/lib/github/listing";
import type { AgentPick } from "@/lib/onboarding/types";
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

const AGENT_PICKS: readonly AgentPick[] = ["claude", "codex", "outrunner", "codex-outrunner"];

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

/** An agent pick from a URL (`?start=`); undefined for anything else. */
export function parseAgentPick(raw: string | null | undefined): AgentPick | undefined {
  return AGENT_PICKS.find((pick) => pick === raw);
}

/** Where onboarding ends: the new-session screen, on the first repository
 *  picked (none: the form's own choice), the composer focused, starting on
 *  the agent picked (`?start=`, read by components/new-session-route.tsx). */
export function newSessionAfterOnboarding(projectId: string | undefined, runOn: AgentPick): string {
  const query = new URLSearchParams({ ...(projectId && { project: projectId }), focus: "composer", start: runOn });
  return `/new?${query}`;
}
