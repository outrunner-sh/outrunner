/**
 * Onboarding's rules, apart from its screens (components/onboarding), so they
 * test on their own.
 */

import { PLANS } from "@/lib/billing/plans";
import type { RepositoryListing } from "@/lib/github/listing";

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

/** The app the CLI signs in to when it's given no --url: its DefaultURL
 *  (runtime-agent/internal/cli/main.go). */
export const CLI_DEFAULT_URL = "https://app.outrunner.sh";

/** The command that connects a Claude subscription from the terminal, run
 *  with `runner` (`npx`, `pnpm dlx`…), for the app at `origin`. It's
 *  `outrunner claude`, not the bare command: the page showing it is open and
 *  moves on by itself, so the CLI mustn't open onboarding in another tab. Any
 *  app but the default is named with --url, or the token would be saved to
 *  that one and this page would never see it. */
export function connectClaudeCommand(runner: string, origin: string): string {
  const url = origin === CLI_DEFAULT_URL ? "" : ` --url ${origin}`;
  return `${runner} outrunner@latest${url} claude`;
}
