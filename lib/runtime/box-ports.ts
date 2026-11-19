import { AGENT_PORT } from "@/lib/runtime/daytona/deploy";

/**
 * Daytona's own daemon on every box (its toolbox, which runs processes, and
 * its SSH and terminal): never a server of the user's, so neither listed
 * (runtime-agent/internal/ports, which holds the same list) nor given a
 * preview link. Both match ProviderPorts in agent-protocol.fixtures.json.
 */
export const PROVIDER_PORTS: readonly number[] = [2280, 22220, 22222, 33333];

/** The port of the desktop's noVNC proxy, whose WebSocket the Desktop tab's
 *  VNC client opens. It forwards to the desktop's VNC server alone. */
export const NOVNC_PORT = 6080;

/** The DevTools port of the desktop's browser, on the box's loopback alone
 *  (runtime-agent/internal/desktop DevToolsPort). */
export const DEVTOOLS_PORT = 19222;

/**
 * The desktop's servers (lib/runtime/sandbox/backend.ts BoxDesktop): x11vnc
 * on 5900 and 5901 and noVNC's proxy, which Daytona's computer use starts, and
 * the DevTools port of the browser the agent's desktop tools launch
 * (runtime-agent/internal/desktop), on loopback. Neither listed nor given a
 * preview link: the desktop has a terminal on it and the browser is whatever
 * the agent signed in to, so a link good for hours would be a long-lived key
 * to both. The Desktop tab is the way in, through a link that lasts minutes.
 * Both lists match DesktopPorts in agent-protocol.fixtures.json.
 */
export const DESKTOP_PORTS: readonly number[] = [5900, 5901, NOVNC_PORT, DEVTOOLS_PORT];

/** Whether a preview link may be made for `port` on a session's box: a
 *  server of the user's, not the agent's, the provider's or the desktop's,
 *  nor privileged. */
export function previewablePort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535 &&
    port !== AGENT_PORT &&
    !PROVIDER_PORTS.includes(port) &&
    !DESKTOP_PORTS.includes(port)
  );
}
