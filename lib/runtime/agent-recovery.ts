import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";

/** Run a session operation, redeploying an unreachable runtime-agent once on
 * the same box and retrying. A reachable agent's application errors remain
 * untouched so setup/auth failures are not hidden by a redeploy. */
export async function withRuntimeAgentRecovery<T>(
  input: {
    provider: ComputerRuntimeProvider;
    sandboxId: string;
    secret: string;
    agent: AgentClient;
    identity: WorkspaceIdentity;
    upgrade: (() => Promise<void>) | undefined;
    workspaceId: string;
  },
  operation: (agent: AgentClient) => Promise<T>,
  onAgent?: (agent: AgentClient) => void,
): Promise<{ agent: AgentClient; result: T }> {
  try {
    return { agent: input.agent, result: await operation(input.agent) };
  } catch (error) {
    // This recovery path only applies when the caller can actually upgrade
    // the runtime-agent. In particular, don't probe a target just to discover
    // that no recovery action is available.
    if (!input.upgrade) throw error;

    const agentResponds = await input.agent.health(input.identity).then(
      () => true,
      () => false,
    );
    if (agentResponds) throw error;

    // The cached endpoint can be stale while the box and agent are healthy.
    // Ask the provider for a fresh target and only redeploy if that endpoint
    // also fails its health check.
    let fresh: AgentClient | undefined;
    try {
      const target = await input.provider.agentTarget(input.sandboxId, input.secret, { fresh: true });
      fresh = new AgentClient(target);
      onAgent?.(fresh);
    } catch (targetError) {
      console.warn(`Runtime recovery: fresh agent target failed for ${input.workspaceId}`, targetError);
    }
    if (fresh) {
      const freshAgentResponds = await fresh.health(input.identity).then(
        () => true,
        () => false,
      );
      if (freshAgentResponds) return { agent: fresh, result: await operation(fresh) };
    }

    console.warn(`Runtime recovery: restarting unreachable runtime-agent for ${input.workspaceId}`, error);
    await input.upgrade();
    const target = await input.provider.agentTarget(input.sandboxId, input.secret, { fresh: true });
    const recovered = new AgentClient(target);
    onAgent?.(recovered);
    await recovered.health(input.identity);
    const result = await operation(recovered);
    return { agent: recovered, result };
  }
}
