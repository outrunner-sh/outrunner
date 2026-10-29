/**
 * What the public API answers with: Outrunner's records in snake_case, with
 * only what a client needs, and a session's status in the API's words
 * rather than the box lifecycle's (lib/runtime/types.ts).
 */

import type { Environment } from "@/lib/db/environments";
import { type Learning, type LearningActor, learningRights } from "@/lib/learnings/rules";
import type { Project, Workspace, WorkspaceSource, WorkspaceStatus } from "@/lib/runtime/types";
import type { TriageItem } from "@/lib/triage/work-items";
import { itemHref, itemKey } from "@/lib/triage/work-items";

/** A session's status as the API says it. */
export type ApiWorkspaceStatus =
  | "preparing"
  | "ready"
  | "suspending"
  | "suspended"
  | "resuming"
  | "archiving"
  | "archived"
  | "restoring"
  | "failed"
  | "deleting"
  | "deleted";

const STATUS: Record<WorkspaceStatus, ApiWorkspaceStatus> = {
  creating: "preparing",
  provisioning: "preparing",
  ready: "ready",
  // Idle is the box's own pause point, nothing a client acts on differently.
  idle: "ready",
  suspending: "suspending",
  suspended: "suspended",
  resuming: "resuming",
  archiving: "archiving",
  archived: "archived",
  restoring: "restoring",
  failed: "failed",
  destroying: "deleting",
  destroyed: "deleted",
};

export const API_STATUSES = [...new Set(Object.values(STATUS))] as readonly ApiWorkspaceStatus[];
export const API_SOURCES: readonly WorkspaceSource[] = ["app", "slack", "automation", "github", "api"];

export function apiStatus(status: WorkspaceStatus): ApiWorkspaceStatus {
  return STATUS[status];
}

/** The lifecycle statuses an API status stands for, to filter by. */
export function statusesFor(status: ApiWorkspaceStatus): WorkspaceStatus[] {
  return (Object.keys(STATUS) as WorkspaceStatus[]).filter((s) => STATUS[s] === status);
}

export function isApiStatus(value: unknown): value is ApiWorkspaceStatus {
  return typeof value === "string" && (API_STATUSES as readonly string[]).includes(value);
}

export function isApiSource(value: unknown): value is WorkspaceSource {
  return typeof value === "string" && (API_SOURCES as readonly string[]).includes(value);
}

/** Where a session opens in the app. */
export function workspaceUrl(base: string, id: string): string {
  return new URL(`/workspaces/${id}`, base).toString();
}

export function workspaceJson(workspace: Workspace, base: string): Record<string, unknown> {
  const status = apiStatus(workspace.status);
  return {
    id: workspace.id,
    title: workspace.title,
    status,
    // The setup step, while there is one.
    setup_phase: status === "preparing" ? workspace.phase : null,
    org_id: workspace.orgId ?? null,
    user_id: workspace.ownerId,
    project_id: workspace.projectId,
    environment_id: workspace.environmentId,
    source: workspace.source ?? "app",
    agent: workspace.agent,
    model: workspace.model
      ? { provider: workspace.model.model.provider, id: workspace.model.model.id, effort: workspace.model.effort }
      : null,
    branch: workspace.branch,
    base_branch: workspace.baseBranch,
    repositories: workspace.checkouts?.map((c) => ({
      project_id: c.projectId,
      full_name: c.fullName,
      folder: c.checkout,
      base_branch: c.baseBranch,
    })) ?? null,
    error_message: workspace.errorMessage,
    url: workspaceUrl(base, workspace.id),
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
    last_active_at: workspace.lastActiveAt,
  };
}

/** A repository connected to the org (a `projects` row). */
export function projectJson(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    org_id: project.orgId,
    full_name: project.fullName,
    default_branch: project.defaultBranch,
    private: project.private,
    language: project.language,
    description: project.description,
    html_url: project.htmlUrl,
    pushed_at: project.pushedAt,
  };
}

/** A project of the app's (an `environments` row): its repositories, and
 *  the one a session started from it works on first. Its secrets' values
 *  never leave Outrunner; their names do. */
export function environmentJson(environment: Environment): Record<string, unknown> {
  return {
    id: environment.id,
    org_id: environment.orgId,
    name: environment.name,
    description: environment.description,
    project_id: environment.defaultForProjectId ?? environment.repos[0]?.projectId ?? null,
    repositories: environment.repos.map((r) => ({
      project_id: r.projectId,
      full_name: r.fullName,
      folder: r.checkoutName,
      branch: r.branch ?? r.defaultBranch,
    })),
    variable_names: environment.envNames,
    access: environment.access,
    updated_at: environment.updatedAt,
  };
}

export function triageItemJson(item: TriageItem, base: string): Record<string, unknown> {
  return {
    id: item.id,
    key: itemKey(item),
    number: item.number,
    project_id: item.projectId,
    title: item.title,
    body: item.body,
    status: item.status,
    source: item.source,
    source_url: item.sourceUrl,
    duplicate_of: item.duplicateOf,
    workspace_id: item.workspaceId,
    can: item.can,
    url: new URL(itemHref(item), base).toString(),
    triaged_at: item.triagedAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

/** A learning (lib/learnings), with what the caller may do with it. */
export function learningJson(learning: Learning, actor: LearningActor): Record<string, unknown> {
  return {
    id: learning.id,
    scope: learning.scope,
    org_id: learning.orgId,
    title: learning.title,
    body: learning.body,
    status: learning.status,
    created_by: learning.createdBy,
    suggested_in: learning.suggestedIn,
    can_edit: learningRights(actor, learning).write,
    created_at: learning.createdAt,
    updated_at: learning.updatedAt,
  };
}

/** Any of a route's own answers in snake_case, keys only, at every depth:
 *  for records passed on whole (a pull request's status from GitHub). */
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)]),
  );
}
