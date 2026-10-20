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
  /** The vCPUs it runs with, where the provider says: a resumed box keeps
   *  the size it was made at, whatever the user's setting is now. */
  readonly cpu?: number;
}

/**
 * The provider's own idle stop on Outrunner's boxes: a backstop, renewed by
 * every reconciler run that keeps the box up (SandboxBackend.keepAlive). It
 * fires only when the reconciler stops looking (the cron down, a row it no
 * longer reads), stopping the box with its disk kept, for the next session to
 * restore. Long enough that a missed run or two never stops a busy box.
 */
export const IDLE_BACKSTOP_SECONDS = 2 * 60 * 60;

/** CPU and memory a new box boots with. */
export type BoxResources = { cpu: number; memoryGb: number };

export interface SandboxBackend {
  /** A box that stays up as long as the provider lets one (forever, but on
   *  Modal: a day), ready to use. `labels` tag it for the provider's console.
   *  `size` is honoured where the provider can size a box (Neev, Modal);
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
  /** Renew the box's {@link IDLE_BACKSTOP_SECONDS} backstop, where it has one. */
  keepAlive?(id: string): Promise<void>;
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
