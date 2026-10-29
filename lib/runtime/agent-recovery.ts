import { AgentClient, AgentRequestError, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";

/** Recovery could not obtain an answering runtime-agent. An HTTP answer
 * from a sandbox proxy is not evidence that the agent or its files answered. */
export class RuntimeAgentUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The runtime-agent could not be reached after recovery.", { cause });
    this.name = "RuntimeAgentUnavailableError";
  }
}

function transportFailure(error: unknown): boolean {
  if (error instanceof AgentRequestError) return !error.error;
  return error instanceof Error && (
    error.name === "TimeoutError" || error.name === "AbortError" ||
    (error instanceof TypeError && (error.message === "fetch failed" || error.message === "Failed to fetch"))
  );
}

async function responds(agent: AgentClient, identity: WorkspaceIdentity): Promise<boolean> {
  try {
    await agent.health(identity);
    return true;
  } catch (error) {
    // A real agent's auth/application refusal still proves it answered.
    // Preserve that session for recovery, even if health did not succeed.
    return !transportFailure(error);
  }
}

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
  const retry = async (agent: AgentClient) => {
    try {
      return { agent, result: await operation(agent) };
    } catch (error) {
      if (transportFailure(error) && !(await responds(agent, input.identity))) throw new RuntimeAgentUnavailableError(error);
      throw error;
    }
  };
  try {
    return { agent: input.agent, result: await operation(input.agent) };
  } catch (error) {
    // A capture/upload/auth error from the agent, or an invalid manifest,
    // must never turn into "unreachable" just because health fails later.
    if (!transportFailure(error)) throw error;
    if (await responds(input.agent, input.identity)) throw error;

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
      if (await responds(fresh, input.identity)) return retry(fresh);
    }

    if (!input.upgrade) throw new RuntimeAgentUnavailableError(error);

    console.warn(`Runtime recovery: restarting unreachable runtime-agent for ${input.workspaceId}`, error);
    let recovered: AgentClient;
    try {
      await input.upgrade();
      const target = await input.provider.agentTarget(input.sandboxId, input.secret, { fresh: true });
      recovered = new AgentClient(target);
      onAgent?.(recovered);
      if (!(await responds(recovered, input.identity))) throw new RuntimeAgentUnavailableError(error);
    } catch (recoveryError) {
      // Both endpoints failed health before recovery. Keep that evidence
      // when a provider's redeploy fails with its own (non-fetch) exception.
      if (recoveryError instanceof RuntimeAgentUnavailableError) throw recoveryError;
      throw new RuntimeAgentUnavailableError(recoveryError);
    }
    return retry(recovered);
  }
}
