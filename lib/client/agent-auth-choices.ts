import { sharedResource } from "@/lib/client/shared-resource";
import type { AgentAuthChoices } from "@/lib/db/credentials";

/**
 * How each coding agent signs in (Settings → Providers), from
 * GET /api/settings/agents: one answer for the page, looked up once and again
 * after a pick is saved (invalidate). Null when the server didn't say.
 */
export const AGENT_AUTH_CHOICES = sharedResource<AgentAuthChoices | null>(
  () =>
    fetch("/api/settings/agents")
      .then((res) => (res.ok ? (res.json() as Promise<{ choices?: AgentAuthChoices }>) : null))
      .then((data) => data?.choices ?? null),
  null,
);
