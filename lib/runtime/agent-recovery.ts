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
): Promise<{ agent: AgentClient; result: T }> {
  try {
    return { agent: input.agent, result: await operation(input.agent) };
  } catch (error) {
    const agentResponds = await input.agent.health(input.identity).then(
      () => true,
      () => false,
    );
    if (!input.upgrade || agentResponds) throw error;

    console.warn(`Runtime recovery: restarting unreachable runtime-agent for ${input.workspaceId}`, error);
    await input.upgrade();
    const target = await input.provider.agentTarget(input.sandboxId, input.secret, { fresh: true });
    const recovered = new AgentClient(target);
    await recovered.health(input.identity);
    const result = await operation(recovered);
    return { agent: recovered, result };
  }
}
