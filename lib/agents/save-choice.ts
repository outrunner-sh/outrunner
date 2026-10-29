import type { AgentId, AuthMethodId } from "@/lib/agents/registry";
import type { AgentAuthChoices } from "@/lib/db/credentials";
import type { TableProbeStatus } from "@/lib/supabase/probe";

export class AgentChoiceDeploymentError extends Error {
  readonly reason: TableProbeStatus | "constraint";
  constructor(reason: TableProbeStatus | "constraint") {
    super("ChatGPT account sign-in needs an Outrunner deployment update. Your previous sign-in choice and API key are unchanged. Please try again after the update.");
    this.reason = reason;
  }
}

type ChoiceStore = {
  read(): Promise<AgentAuthChoices>;
  write(agent: AgentId, method: AuthMethodId): Promise<void>;
  codexSchema(): Promise<TableProbeStatus>;
};

/** No post-write read: a failed subsequent read must not tell the browser a
 * successful choice update failed. The write is one atomic upsert, and never
 * edits any credential. The caller validates agent/method against the registry. */
export async function saveAgentChoice(store: ChoiceStore, agent: AgentId, method: AuthMethodId): Promise<AgentAuthChoices> {
  const choices = await store.read();
  const account = agent === "codex" && method === "codex-account";
  if (account) {
    const schema = await store.codexSchema();
    if (schema !== "ok") throw new AgentChoiceDeploymentError(schema);
  }
  try {
    await store.write(agent, method);
  } catch (error) {
    // An existing deployment's old method CHECK refuses this newly added
    // registry method (23514); a rejected upsert retains the previous row.
    if (account && (error as { code?: string })?.code === "23514")
      throw new AgentChoiceDeploymentError("constraint");
    throw error;
  }
  return { ...choices, [agent]: method };
}
