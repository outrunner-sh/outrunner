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
}

export interface SandboxBackend {
  /** An always-on box (never stopped or deleted on its own), ready to use.
   *  `labels` tag it for the provider's console. */
  create(labels: Record<string, string>): Promise<SandboxBox>;
  get(id: string): Promise<SandboxBox>;
  /** Whether it is up and able to host sessions. False when it is gone. */
  alive(id: string): Promise<boolean>;
  delete(id: string): Promise<void>;
}

/** `$HOME` from the box's login shell, or `fallback` if it says nothing. */
export async function homeOf(io: BoxIO, fallback: string): Promise<string> {
  return ((await io.exec("bash -lc 'echo $HOME'")).stdout || "").trim() || fallback;
}
