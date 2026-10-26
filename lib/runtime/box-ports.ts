import { AGENT_PORT } from "@/lib/runtime/daytona/deploy";

/**
 * Daytona's own daemon on every box (its toolbox, which runs processes, and
 * its SSH and terminal): never a server of the user's, so neither listed
 * (runtime-agent/internal/ports, which holds the same list) nor given a
 * preview link. Both match ProviderPorts in agent-protocol.fixtures.json.
 */
export const PROVIDER_PORTS: readonly number[] = [2280, 22220, 22222, 33333];

/** Whether a preview link may be made for `port` on a session's box: a
 *  server of the user's, not the agent's or the provider's, nor privileged. */
export function previewablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== AGENT_PORT && !PROVIDER_PORTS.includes(port);
}
