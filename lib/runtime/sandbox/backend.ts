/**
 * The sandbox a Runtime Computer runs on, seen from the control plane: the few
 * things it needs from any sandbox provider. Everything above this — deploying
 * the agent, the git mirror and worktrees, commits and pushes — is shared
 * (lib/runtime/computer-provider.ts), so swapping providers means implementing
 * only this.
 */

import type { BoxIO } from "@/lib/runtime/daytona/deploy";
import type { GitExec } from "@/lib/runtime/git";

/** Where the control plane and the browser reach the agent on a box. */
export type AgentEndpoint = {
  /** Base URL for server-side control calls. */
  controlBaseUrl: string;
  /** Headers those calls need to get through the provider's proxy. */
  controlHeaders: Record<string, string>;
  /** Base URL a browser WebSocket can open as is (any credential in it). */
  wsBaseUrl: string;
};

/** How this server reaches a port on a box for a preview: a base URL, the
 *  headers that get a request through the provider's proxy (its credential
 *  among them), and whether the box's server is sent the preview's own host
 *  (a way straight to the port) or the URL's (a provider's proxy, which
 *  routes by it). */
export type PreviewTarget = {
  baseUrl: string;
  headers: Record<string, string>;
  hostHeader: "preview" | "upstream";
  /** Ends the way in at once, where its credential can be (a Daytona link
   *  signed for the port): for a preview deleted or made sign-in only. */
  revoke?: () => Promise<void>;
};

/** One running sandbox. */
export interface SandboxBox {
  readonly id: string;
  /** Run, launch detached, upload: what deploying the agent needs. */
  readonly io: BoxIO;
  /** Git through the box's shell; a credential rides in `env`, never argv. */
  readonly gitExec: GitExec;
  /** The box user's home, where the agent and the mirror live. */
  home(): Promise<string>;
  agentEndpoint(port: number): Promise<AgentEndpoint>;
  /** A URL a browser can open the box's `port` at for `ttlSeconds`, its
   *  credential in it: for the session's editor. Absent where the provider
   *  can't make one. */
  browserUrl?(port: number, ttlSeconds: number): Promise<string>;
  /** Its desktop, where the provider has one (Daytona). Absent elsewhere. */
  readonly desktop?: BoxDesktop;
  /** Where this server reaches the box's `port` for a preview it proxies
   *  (lib/previews/proxy.ts): never handed to a browser. Absent where the
   *  provider has no way in. */
  previewTarget?(port: number): Promise<PreviewTarget>;
  /** The vCPUs it runs with, where the provider says: a resumed box keeps
   *  the size it was made at, whatever the user's setting is now. */
  readonly cpu?: number;
  readonly memoryGb?: number;
  /** Increase RAM without stopping processes. CPU and disk stay as they are. */
  growMemory?(memoryGb: number): Promise<void>;
}

/**
 * A box's desktop: a virtual display with a window manager, which the agent's
 * desktop tools drive and the session's owner watches in the Desktop tab. Off
 * until something asks for it, so an idle box doesn't run a display server
 * nobody looks at.
 */
export interface BoxDesktop {
  /** Start it, or leave it running if it is: resolves once it's up. */
  start(): Promise<void>;
  /** How a browser's VNC client gets on: the WebSocket, its credential in
   *  the URL and good for `ttlSeconds` (long enough to open the socket, which
   *  stays open after it lapses), and the VNC password, where the desktop has
   *  one. It reaches the desktop's VNC server and nothing else on the box. */
  viewer(ttlSeconds: number): Promise<DesktopLink>;
}

/** A desktop link for the owner's browser (the Desktop tab): its noVNC
 *  socket, and the VNC password where the desktop asks for one (E2B's, whose
 *  port anyone could reach; a new one each time). */
export type DesktopLink = { url: string; password?: string };

/** CPU and memory a new box boots with. */
export type BoxResources = { cpu: number; memoryGb: number };

export interface SandboxBackend {
  /** A box that stays up as long as the provider lets one (forever, but on
   *  Modal: a day), ready to use. `labels` tag it for the provider's console.
   *  `size` is honoured where the provider can size a box (Neev, Modal; on
   *  Daytona, a snapshot within both resources, logging size mismatches);
   *  elsewhere it gets the provider's default. */
  create(labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox>;
  /**
   * A box back on the disk the ended box `id` left, so the sessions on it
   * carry on: for a provider whose boxes end on their own (Modal, a new box on
   * that disk), or one that pauses them ({@link pause}: the same box, running
   * again). Nothing runs on it yet, the agent included. Null when that disk is
   * gone, so a new box is the only way on; a throw when the provider couldn't
   * be asked.
   */
  restore?(id: string, labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox | null>;
  /** Stop a box but keep its disk, for {@link restore} to bring back: how an
   *  idle box stops costing compute. Only on providers that can. */
  pause?(id: string): Promise<void>;
  get(id: string): Promise<SandboxBox>;
  /** Whether it is up and able to host sessions. False when it is gone or
   *  stopped; a throw when the provider couldn't be asked. */
  alive(id: string): Promise<boolean>;
  delete(id: string): Promise<void>;
}

/** `$HOME` from the box's login shell, or `fallback` if it says nothing. */
export async function homeOf(io: BoxIO, fallback: string): Promise<string> {
  return ((await io.exec("bash -lc 'echo $HOME'")).stdout || "").trim() || fallback;
}

/** The non-root user the agent and Claude run as on a box whose own user is
 *  root (Neev, Modal): Claude refuses bypassPermissions as root. */
export const BOX_USER = "runtime";

/** `runuser` arguments for `command` as {@link BOX_USER} in a login shell. An
 *  env var is let through by name only; its value travels in the exec's
 *  environment, never in argv. */
export function asUserArgs(command: string, env?: Record<string, string>): string[] {
  const names = Object.keys(env ?? {});
  return ["-l", BOX_USER, ...(names.length > 0 ? ["-w", names.join(",")] : []), "-c", command];
}
