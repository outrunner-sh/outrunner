/**
 * Onboarding's rules, apart from its screens (components/onboarding), so they
 * test on their own.
 */

import type { RepositoryListing } from "@/lib/github/listing";
import type { AgentMethod, AgentPick, AgentStatus } from "@/lib/onboarding/types";

/** Whether a pick can run a session now, on the method shown. */
export function agentReady(pick: AgentPick, method: AgentMethod, status: AgentStatus | null): boolean {
  if (pick === "outrunner") return true;
  if (!status) return false;
  if (pick === "codex") return status.codex.apiKey;
  return method === "subscription" ? status.claude.subscription : status.claude.apiKey;
}

/** The pick a returning user starts on: what they've connected. */
export function initialPick(status: AgentStatus | null, outrunnerModels: boolean): AgentPick {
  if (status?.claude.subscription || status?.claude.apiKey) return "claude";
  if (status?.codex.apiKey) return "codex";
  return outrunnerModels ? "outrunner" : "claude";
}

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
