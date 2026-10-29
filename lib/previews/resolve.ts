/**
 * The gate a preview's visitor passes on every request (asked by the proxy,
 * lib/previews/proxy.ts, through app/api/previews/gate): does the preview
 * still exist, may this visitor see it, is its session awake, and where is
 * its box. Answered afresh each time the proxy's few seconds of memory run
 * out, so a deleted preview, a mode switched back to login or a member who
 * lost access is shut out within them.
 *
 * Who gets through:
 * - a `public` preview: anyone;
 * - a `login` preview: a visitor whose preview session (lib/previews/tokens.ts)
 *   says they are the session's owner, or a member of its org with read
 *   access to its repository, as Roles & access stand now;
 * - nobody, to the agent's own port or the provider's (lib/runtime/box-ports.ts),
 *   whatever a row says.
 */

import type { Preview } from "@/lib/db/previews";
import { type AccessLevel, allows } from "@/lib/orgs/access";
import { PREVIEW_SLUG } from "@/lib/previews/host";
import { previewsSupported } from "@/lib/previews/rules";
import { sessionUser } from "@/lib/previews/tokens";
import type { GateDecision, PreviewUpstream } from "@/lib/previews/wire";
import { previewablePort } from "@/lib/runtime/box-ports";
import type { RuntimeComputer, Workspace, WorkspaceStatus } from "@/lib/runtime/types";

/** How long the proxy may act on an answer before asking again. Short:
 *  it's how long a revoked link can still work. */
export const ALLOW_TTL_MS = 10_000;
/** A page that says to wait (asleep, starting) is asked again sooner. */
const WAIT_TTL_MS = 3_000;
const GONE_TTL_MS = 10_000;

export type GateDeps = {
  key: Buffer;
  /** The app's origin, where visitors sign in. */
  appBase: string;
  preview(slug: string): Promise<Preview | null>;
  workspace(id: string): Promise<Workspace | null>;
  box(workspace: Workspace): Promise<RuntimeComputer | null>;
  projectLevel(userId: string, projectId: string): Promise<AccessLevel | null>;
  isMember(userId: string, orgId: string): Promise<boolean>;
  /** Where this server reaches the box's port; null where it can't. */
  upstream(workspace: Workspace, sandboxId: string, port: number): Promise<PreviewUpstream | null>;
  now?: () => number;
};

const ENDED: readonly WorkspaceStatus[] = ["destroying", "destroyed"];
const ASLEEP: readonly WorkspaceStatus[] = ["suspending", "suspended", "archiving", "archived"];
const STARTING: readonly WorkspaceStatus[] = ["creating", "provisioning", "resuming", "restoring"];

/** Whether waking a session from its preview can do anything: the
 *  lifecycle route resumes a suspended one and restores an archived one,
 *  and refuses the rest. */
export function wakeable(status: WorkspaceStatus): boolean {
  return status === "suspended" || status === "archived";
}

/** Whether `userId` may see a session's previews: its owner while still a
 *  member of its org (as they may see the session itself), or a member who
 *  can read its repository. */
export async function mayView(
  deps: Pick<GateDeps, "projectLevel" | "isMember">,
  userId: string,
  workspace: Pick<Workspace, "ownerId" | "projectId" | "orgId">,
): Promise<boolean> {
  if (userId === workspace.ownerId) return !!workspace.orgId && (await deps.isMember(userId, workspace.orgId));
  return allows(await deps.projectLevel(userId, workspace.projectId), "read");
}

const page = (status: number, name: Extract<GateDecision, { kind: "page" }>["page"], ttlMs: number, canWake?: boolean): GateDecision => ({
  kind: "page",
  status,
  page: name,
  ttlMs,
  ...(canWake !== undefined && { canWake }),
});

/** What to do with a visitor to `slug` holding `session` (their cookie). */
export async function resolvePreview(deps: GateDeps, slug: string, session: string | null): Promise<GateDecision> {
  if (!PREVIEW_SLUG.test(slug)) return page(404, "missing", GONE_TTL_MS);
  const preview = await deps.preview(slug);
  if (!preview || !previewablePort(preview.port)) return page(404, "missing", GONE_TTL_MS);
  const workspace = await deps.workspace(preview.workspaceId);
  if (!workspace || ENDED.includes(workspace.status)) return page(410, "ended", GONE_TTL_MS);

  // On a public preview a visitor's session only says whether they own it.
  const viewer = sessionUser(deps.key, session, slug, deps.now?.() ?? Date.now());
  if (preview.mode === "login") {
    if (!viewer) return { kind: "login", signInUrl: `${deps.appBase}/previews/${slug}`, ttlMs: GONE_TTL_MS };
    if (!(await mayView(deps, viewer, workspace))) return page(403, "denied", GONE_TTL_MS);
  }
  if (!previewsSupported(workspace.provider)) return page(501, "unsupported", GONE_TTL_MS);

  // Waking costs the owner's hours, so only they are offered it, while
  // still a member of the org (on a public preview mayView hasn't asked),
  // and only where the lifecycle route can act (resume: suspended,
  // restore: archived).
  const canWake =
    viewer === workspace.ownerId &&
    wakeable(workspace.status) &&
    (preview.mode === "login" || (await mayView(deps, viewer, workspace)));
  if (ASLEEP.includes(workspace.status)) return page(503, "asleep", WAIT_TTL_MS, canWake);
  if (workspace.status === "failed") return page(503, "failed", WAIT_TTL_MS);
  if (STARTING.includes(workspace.status)) return page(503, "starting", WAIT_TTL_MS);
  const box = await deps.box(workspace);
  if (!box?.daytonaSandboxId || box.status !== "ready") {
    return box?.status === "provisioning"
      ? page(503, "starting", WAIT_TTL_MS)
      : page(503, "asleep", WAIT_TTL_MS, canWake);
  }

  let upstream: PreviewUpstream | null;
  try {
    upstream = await deps.upstream(workspace, box.daytonaSandboxId, preview.port);
  } catch (error) {
    console.error(`Preview ${preview.id}: couldn't find a way to its box`, error);
    return page(502, "unavailable", WAIT_TTL_MS);
  }
  if (!upstream) return page(501, "unsupported", GONE_TTL_MS);
  return { kind: "proxy", upstream, mode: preview.mode, ttlMs: ALLOW_TTL_MS };
}

/** The session `slug` previews, when `session` signs in its owner, still a
 *  member of its org, and it can be woken: for waking it. */
export async function wakeTarget(
  deps: Pick<GateDeps, "key" | "preview" | "workspace" | "now" | "projectLevel" | "isMember">,
  slug: string,
  session: string | null,
): Promise<Workspace | null> {
  if (!PREVIEW_SLUG.test(slug)) return null;
  const viewer = sessionUser(deps.key, session, slug, deps.now?.() ?? Date.now());
  if (!viewer) return null;
  const preview = await deps.preview(slug);
  const workspace = preview ? await deps.workspace(preview.workspaceId) : null;
  if (!workspace || workspace.ownerId !== viewer || !wakeable(workspace.status)) return null;
  return (await mayView(deps, viewer, workspace)) ? workspace : null;
}
