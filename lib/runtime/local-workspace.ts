/**
 * Server-side bookkeeping for local workspaces (provider `desktop`).
 *
 * A local session runs on the user's own Mac, driven by the Outrunner app,
 * which talks to the agent there over IPC. The control plane cannot reach that
 * machine, so for these workspaces it only keeps the record: the app creates the
 * row, does the agent work itself, and reports each outcome back. Everything
 * here is pure so it can be tested without a request or a database.
 */

import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";

/** Same shape the agent and the app accept for ids. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const MAX_ERROR_LENGTH = 500;
const MAX_PATH_LENGTH = 1024;

/** `sandbox_id` of a local workspace: the Mac it runs on. */
export function localSandboxId(deviceId: string): string {
  return `desktop:${deviceId}`;
}

/** The device a local workspace runs on, or null for any other workspace. */
export function localDeviceOf(workspace: Pick<Workspace, "provider" | "sandboxId">): string | null {
  if (workspace.provider !== "desktop" || !workspace.sandboxId?.startsWith("desktop:")) {
    return null;
  }
  return workspace.sandboxId.slice("desktop:".length) || null;
}

export type CreateLocation =
  | { location: "cloud" }
  | { location: "local"; deviceId: string }
  | { error: string };

/** Where a create request asks the workspace to run. Absent means cloud. */
export function parseCreateLocation(body: { location?: unknown; deviceId?: unknown }): CreateLocation {
  if (body.location === undefined || body.location === "cloud") return { location: "cloud" };
  if (body.location !== "local") return { error: "Choose a cloud or local workspace." };
  if (typeof body.deviceId !== "string" || !ID_PATTERN.test(body.deviceId)) {
    return { error: "Local workspaces must name the Mac they run on." };
  }
  return { location: "local", deviceId: body.deviceId };
}

/** What the app reports after doing a step on the user's Mac. */
export type LocalEvent =
  | { event: "ready"; worktreePath: string }
  | { event: "failed"; error: string }
  | { event: "suspended" }
  | { event: "resumed" }
  | { event: "destroyed" };

export function parseLocalEvent(body: unknown): LocalEvent | null {
  if (!body || typeof body !== "object") return null;
  const { event, worktreePath, error } = body as Record<string, unknown>;
  switch (event) {
    case "ready":
      // Recorded and shown in the UI; it must look like a path on a Mac.
      return typeof worktreePath === "string" &&
        worktreePath.startsWith("/") &&
        worktreePath.length <= MAX_PATH_LENGTH &&
        !worktreePath.includes("\0")
        ? { event, worktreePath }
        : null;
    case "failed":
      return {
        event,
        error:
          typeof error === "string" && error.trim()
            ? error.trim().slice(0, MAX_ERROR_LENGTH)
            : "Could not start the local session.",
      };
    case "suspended":
    case "resumed":
    case "destroyed":
      return { event };
    default:
      return null;
  }
}

const LIVE: WorkspaceStatus[] = ["ready", "idle"];
const NOT_DESTROYED: WorkspaceStatus[] = [
  "creating",
  "provisioning",
  "ready",
  "idle",
  "suspending",
  "resuming",
  "suspended",
  "destroying",
  "failed",
];

/**
 * The guarded status change one event makes: the states it may leave and what
 * it writes. Applied with `transitionWorkspace`, so a stale or replayed report
 * (two tabs, a retry) cannot move a workspace backwards.
 */
export function localTransition(event: LocalEvent): {
  from: WorkspaceStatus[];
  patch: {
    status: WorkspaceStatus;
    phase?: "claude_ready";
    worktreePath?: string;
    errorMessage?: string | null;
    touchActive?: boolean;
  };
} {
  switch (event.event) {
    case "ready":
      return {
        from: ["creating", "provisioning"],
        patch: {
          status: "ready",
          phase: "claude_ready",
          worktreePath: event.worktreePath,
          errorMessage: null,
          touchActive: true,
        },
      };
    case "failed":
      return { from: ["creating", "provisioning"], patch: { status: "failed", errorMessage: event.error } };
    case "suspended":
      return { from: LIVE, patch: { status: "suspended", errorMessage: null } };
    case "resumed":
      return {
        from: [...LIVE, "suspended"],
        patch: { status: "ready", errorMessage: null, touchActive: true },
      };
    case "destroyed":
      return { from: NOT_DESTROYED, patch: { status: "destroyed", errorMessage: null } };
  }
}
