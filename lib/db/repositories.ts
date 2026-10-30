import type { AgentId } from "@/lib/agents/registry";
import { isUuid } from "@/lib/ids";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import {
  toJob,
  toProject,
  toRuntimeComputer,
  toWorkspace,
  toWorkspacePullRequest,
  toWorkspaceSnapshot,
} from "@/lib/db/mappers";
import type { ComputerScope } from "@/lib/runtime/computer-scope";
import type { FirstPromptClaim } from "@/lib/session/first-prompt-claim";
import type { RecordedModel } from "@/lib/runtime/session-models";
import type { SessionMode } from "@/lib/runtime/agent-protocol";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import type {
  ArchivePolicy,
  WorkspaceSnapshot,
} from "@/lib/runtime/snapshot/types";
import type {
  Job,
  JobAgent,
  JobStatus,
  Project,
  ProviderName,
  ProvisionPhase,
  ProvisionTimings,
  RuntimeComputer,
  RuntimeComputerStatus,
  SessionCheckout,
  Workspace,
  WorkspacePullRequest,
  WorkspaceSource,
  WorkspaceStatus,
} from "@/lib/runtime/types";

/**
 * Data access for the three tables. RLS already restricts rows to the owner,
 * so these helpers never filter by owner_id on read.
 */

// --- projects --------------------------------------------------------------

/** The projects of `orgId`, or of every org the user is in when it's not
 *  given (RLS: an org's members see its projects). */
export async function listProjects(orgId?: string): Promise<Project[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("projects")
    .select("*")
    .is("hidden_at", null)
    .order("pushed_at", { ascending: false, nullsFirst: false });
  if (orgId) query = query.eq("org_id", orgId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(toProject);
}

export async function getProject(id: string): Promise<Project | null> {
  if (!isUuid(id)) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data ? toProject(data) : null;
}

/** Projects by id, hidden ones included, in one query. */
export async function getProjects(ids: string[]): Promise<Project[]> {
  if (ids.length === 0) return [];
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("projects").select("*").in("id", ids);

  if (error) throw error;
  return (data ?? []).map(toProject);
}

/**
 * Upsert the repositories returned by GitHub as projects of `orgId` (the
 * owner's personal org when not given), keyed on (org, repo id). A repository
 * another member connected to the org already is theirs: it's left as it is
 * (only its owner may change it) and not counted.
 */
export async function upsertProjects(
  ownerId: string,
  repos: Array<{
    githubRepoId: number;
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
    private: boolean;
    language: string | null;
    description: string | null;
    htmlUrl: string;
    pushedAt: string | null;
  }>,
  orgId?: string,
): Promise<number> {
  if (repos.length === 0) return 0;

  const supabase = await createSupabaseServerClient();
  let mine = repos;
  if (orgId) {
    const { data: theirs, error: lookupError } = await supabase
      .from("projects")
      .select("github_repo_id")
      .eq("org_id", orgId)
      .neq("owner_id", ownerId)
      .in(
        "github_repo_id",
        repos.map((r) => r.githubRepoId),
      );
    if (lookupError) throw lookupError;
    const taken = new Set((theirs ?? []).map((p) => p.github_repo_id));
    mine = repos.filter((r) => !taken.has(r.githubRepoId));
    if (mine.length === 0) return 0;
  }
  const { error, count } = await supabase
    .from("projects")
    .upsert(
      mine.map((r) => ({
        ...(orgId ? { org_id: orgId } : {}),
        owner_id: ownerId,
        github_repo_id: r.githubRepoId,
        full_name: r.fullName,
        owner: r.owner,
        name: r.name,
        default_branch: r.defaultBranch,
        is_private: r.private,
        language: r.language,
        description: r.description,
        html_url: r.htmlUrl,
        pushed_at: r.pushedAt,
      })),
      { onConflict: "org_id,github_repo_id", count: "exact" },
    );

  if (error) throw error;
  return count ?? mine.length;
}

// --- workspaces ------------------------------------------------------------

/** The user's live sessions (RLS: only their own), of one project or one
 *  org when asked. */
export async function listWorkspaces(
  filter: { projectId?: string; orgId?: string } = {},
): Promise<Workspace[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("workspaces")
    .select("*")
    .neq("status", "destroyed")
    // A Slack thread's research session runs out of sight.
    .eq("background", false)
    .order("last_active_at", { ascending: false, nullsFirst: false });

  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.orgId) query = query.eq("org_id", filter.orgId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(toWorkspace);
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  if (!isUuid(id)) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data ? toWorkspace(data) : null;
}

export async function createWorkspaceRow(input: {
  /** The id the new-session screen made for it, opening its page before
   *  this row exists; the database's own when not given. */
  id?: string;
  ownerId: string;
  projectId: string;
  branch: string;
  baseBranch: string;
  provider: ProviderName;
  /** Claude Code when not named. */
  agent?: AgentId;
  /** The project it starts from; null before the migration that adds them. */
  environmentId?: string | null;
  /** A multi-repository session's repositories. */
  checkouts?: SessionCheckout[] | null;
  /** Where it was started; the app when not named. */
  source?: WorkspaceSource;
  /** A Mission, or a Runner of one (docs/missions.md); named only when so. */
  kind?: "mission";
  parentMissionId?: string;
}): Promise<Workspace> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .insert({
      ...(input.id && { id: input.id }),
      owner_id: input.ownerId,
      project_id: input.projectId,
      branch: input.branch,
      base_branch: input.baseBranch,
      provider: input.provider,
      // Named only for Codex, so a database before 20261020130000 still
      // makes Claude Code sessions (its default) and refuses only Codex's.
      ...(input.agent && input.agent !== "claude" && { agent: input.agent }),
      // Named only when there is one, for the same reason.
      ...(input.environmentId && { environment_id: input.environmentId }),
      ...(input.checkouts && { checkouts: input.checkouts }),
      ...(input.source && input.source !== "app" && { source: input.source }),
      ...(input.kind && { kind: input.kind }),
      ...(input.parentMissionId && { parent_mission_id: input.parentMissionId }),
      status: "creating",
    })
    .select("*")
    .single();

  if (error) throw error;
  return toWorkspace(data);
}

/**
 * The live session already on `branch`, when one is: the one a new session on
 * the same branch is refused for, named in the refusal. The index allows one
 * session per branch while it isn't destroyed.
 */
export async function liveWorkspaceOnBranch(
  ownerId: string,
  projectId: string,
  branch: string,
): Promise<Workspace | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .eq("branch", branch)
    .neq("status", "destroyed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? toWorkspace(data) : null;
}
/**
 * Give a workspace its title, unless it already has one: the first prompt
 * names the session for good. Conditional in the database (`title is null`),
 * so two first prompts racing cannot overwrite each other. True when this call
 * set it.
 */
export async function setWorkspaceTitleIfUnset(id: string, title: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .update({ title })
    .eq("id", id)
    .is("title", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Claim the session's first prompt for `key`, before it is sent: "claimed"
 * when this call took it (free, or `key`'s own claim abandoned mid-send before
 * `abandonedBefore`), with the claimed_at it wrote as the claim's token; "sent"
 * when `key` holds it and its send went, "sending" when that send is still
 * going, "other" when another key holds it. Conditional, as the title is, so
 * two sends racing can't both claim it.
 */
export async function claimFirstPrompt(id: string, key: string, abandonedBefore: string): Promise<FirstPromptClaim> {
  const supabase = await createSupabaseServerClient();
  const claimedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("workspaces")
    .update({ first_prompt_key: key, first_prompt_claimed_at: claimedAt, first_prompt_sent_at: null })
    .eq("id", id)
    .is("first_prompt_key", null)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length > 0) return { state: "claimed", claimedAt };
  const { data: retaken, error: retakeError } = await supabase
    .from("workspaces")
    .update({ first_prompt_claimed_at: claimedAt })
    .eq("id", id)
    .eq("first_prompt_key", key)
    .is("first_prompt_sent_at", null)
    .lt("first_prompt_claimed_at", abandonedBefore)
    .select("id");
  if (retakeError) throw retakeError;
  if ((retaken ?? []).length > 0) return { state: "claimed", claimedAt };
  const { data: row, error: readError } = await supabase
    .from("workspaces")
    .select("first_prompt_key, first_prompt_sent_at")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw readError;
  if (row?.first_prompt_key !== key) return { state: "other" };
  return { state: row.first_prompt_sent_at ? "sent" : "sending" };
}

/** The first-prompt claim `claimedAt` names, matched on its key and token. */
function ownClaim<Q extends { eq: (column: string, value: string) => Q; is: (column: string, value: null) => Q }>(
  query: Q,
  id: string,
  key: string,
  claimedAt: string,
): Q {
  return query
    .eq("id", id)
    .eq("first_prompt_key", key)
    .eq("first_prompt_claimed_at", claimedAt)
    .is("first_prompt_sent_at", null);
}

/** Renew the claim `claimedAt` names, just before its prompt goes: its new
 *  token, or null when another request has taken it over. */
export async function renewFirstPrompt(id: string, key: string, claimedAt: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const renewedAt = new Date().toISOString();
  const { data, error } = await ownClaim(
    supabase.from("workspaces").update({ first_prompt_claimed_at: renewedAt }),
    id,
    key,
    claimedAt,
  ).select("id");
  if (error) throw error;
  return (data ?? []).length > 0 ? renewedAt : null;
}

/** The first prompt claimed under `claimedAt` reached the box: repeats are answered as sent. */
export async function markFirstPromptSent(id: string, key: string, claimedAt: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await ownClaim(
    supabase.from("workspaces").update({ first_prompt_sent_at: new Date().toISOString() }),
    id,
    key,
    claimedAt,
  );
  if (error) throw error;
}

/** Let the claim go, as a send that failed does, so a retry with `key` sends. */
export async function releaseFirstPrompt(id: string, key: string, claimedAt: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await ownClaim(
    supabase.from("workspaces").update({ first_prompt_key: null, first_prompt_claimed_at: null }),
    id,
    key,
    claimedAt,
  );
  if (error) throw error;
}

/** Fields a workspace update may set, by their Workspace names. */
type WorkspacePatch = {
  status?: WorkspaceStatus;
  phase?: ProvisionPhase | null;
  sandboxId?: string | null;
  volumeName?: string | null;
  computerId?: string | null;
  tmuxSession?: string | null;
  agentWorkspaceId?: string | null;
  worktreePath?: string | null;
  errorMessage?: string | null;
  touchActive?: boolean;
};

/** The columns a patch sets: only the fields it names. */
function workspaceColumns(patch: WorkspacePatch) {
  return {
    ...(patch.status !== undefined && { status: patch.status }),
    ...(patch.phase !== undefined && { phase: patch.phase }),
    ...(patch.sandboxId !== undefined && { sandbox_id: patch.sandboxId }),
    ...(patch.volumeName !== undefined && { volume_name: patch.volumeName }),
    ...(patch.computerId !== undefined && { computer_id: patch.computerId }),
    ...(patch.tmuxSession !== undefined && { tmux_session: patch.tmuxSession }),
    ...(patch.agentWorkspaceId !== undefined && {
      agent_workspace_id: patch.agentWorkspaceId,
    }),
    ...(patch.worktreePath !== undefined && {
      worktree_path: patch.worktreePath,
    }),
    ...(patch.errorMessage !== undefined && {
      error_message: patch.errorMessage,
    }),
    ...(patch.touchActive && { last_active_at: new Date().toISOString() }),
  };
}

export async function updateWorkspace(id: string, patch: WorkspacePatch): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("workspaces")
    .update(workspaceColumns(patch))
    .eq("id", id);

  if (error) throw error;
}

/**
 * Record the model a session was just put on, so its next relaunch goes back
 * on it (workspaces.model_*). Best effort: the session is already on it, and
 * a database from before the columns can't say so; that session relaunches
 * as one from before them does.
 */
export async function recordWorkspaceModel(id: string, recorded: RecordedModel): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("workspaces")
    .update({
      model_provider: recorded.model.provider,
      model_id: recorded.model.id,
      model_effort: recorded.effort,
    })
    .eq("id", id);
  if (error) console.warn(`Workspace ${id}: could not record its model ${recorded.model.provider}/${recorded.model.id}`, error);
}

/**
 * Record the mode a session's prompt just went in (workspaces.session_mode),
 * so it opens in it again. Best effort, as recordWorkspaceModel: the box has
 * it already, and a database from before the column keeps it there alone.
 */
export async function recordWorkspaceMode(id: string, mode: SessionMode): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("workspaces").update({ session_mode: mode }).eq("id", id);
  if (error) console.warn(`Workspace ${id}: could not record its ${mode} mode`, error);
}

/**
 * Move a workspace only if it remains in an expected state. Lifecycle actions
 * use this optimistic transition so a second tab cannot start a duplicate
 * suspend, resume, or destroy operation against the same provider resource.
 */
export async function transitionWorkspace(input: {
  id: string;
  from: WorkspaceStatus[];
  patch: WorkspacePatch & { status: WorkspaceStatus };
}): Promise<Workspace | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .update(workspaceColumns(input.patch))
    .eq("id", input.id)
    .in("status", input.from)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? toWorkspace(data) : null;
}

// --- runtime computers -----------------------------------------------------

/** The box of `scope`, if one has been claimed: a workspace's own, or a
 *  project's shared one from before (lib/runtime/computer-scope.ts). */
export async function getRuntimeComputer(scope: ComputerScope): Promise<RuntimeComputer | null> {
  const supabase = await createSupabaseServerClient();
  const read = (pooledColumn: boolean) => {
    const query = supabase.from("runtime_computers").select("*");
    if ("workspaceId" in scope) return query.eq("workspace_id", scope.workspaceId).maybeSingle();
    const shared = query.eq("project_id", scope.projectId).is("workspace_id", null);
    return (pooledColumn ? shared.eq("pooled", false) : shared).maybeSingle();
  };
  let { data, error } = await read(true);
  // Before the warm pool's migration there is no `pooled`, and no pooled box.
  if (error && probeStatus(error) === "outdated" && !("workspaceId" in scope)) ({ data, error } = await read(false));

  if (error) throw error;
  return data ? toRuntimeComputer(data) : null;
}

/** One Runtime Computer by id, still owner-scoped by RLS. Used after an
 * atomic pool claim, whose row may stop being pooled before it is read. */
export async function getRuntimeComputerById(id: string): Promise<RuntimeComputer | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("runtime_computers").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toRuntimeComputer(data) : null;
}

/** The project's shared box from before each session had its own, if it has one. */
export function getRuntimeComputerByProject(projectId: string): Promise<RuntimeComputer | null> {
  return getRuntimeComputer({ projectId });
}

/**
 * The box a workspace's session is on: its own, or, for a session from
 * before each had its own, the project's shared box it was set up on. Null
 * when it has none yet (a session setting up, or one archived off a box).
 */
export async function getWorkspaceComputer(
  workspace: Pick<Workspace, "id" | "computerId">,
): Promise<RuntimeComputer | null> {
  if (!workspace.computerId) return getRuntimeComputer({ workspaceId: workspace.id });
  // Both in one read: its own box, and the one it records (usually the same).
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .select("*")
    .or(`workspace_id.eq.${workspace.id},id.eq.${workspace.computerId}`);
  if (error) throw error;
  const rows = (data ?? []).map(toRuntimeComputer);
  return rows.find((row) => row.workspaceId === workspace.id) ?? rows[0] ?? null;
}

/** What a plan's box count is counted over (see lib/billing/limits.ts),
 *  whatever their state: an org's computers, every member's but its
 *  connector's (which is on its own plan); or one owner's, the connector's.
 *  As the server: a member sees only their own. */
export async function runtimeComputersFor(
  whose: { orgId: string } | { ownerId: string },
): Promise<RuntimeComputer[]> {
  const supabase = createSupabaseAdminClient();
  const query = supabase.from("runtime_computers").select("*");
  const { data, error } = await ("orgId" in whose
    ? query.eq("org_id", whose.orgId)
    : query.eq("owner_id", whose.ownerId)
  ).order("id");
  if (error) throw error;
  const connectors = "orgId" in whose ? await orgConnectorIds(whose.orgId) : new Set<string>();
  return (data ?? []).filter((row) => !connectors.has(row.owner_id)).map(toRuntimeComputer);
}

/** The org's connector, whose boxes and hours are its own plan's. */
export async function orgConnectorIds(orgId: string): Promise<Set<string>> {
  const { data, error } = await createSupabaseAdminClient().from("org_connectors").select("user_id").eq("org_id", orgId);
  if (error && probeStatus(error) === "missing") return new Set();
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.user_id));
}

/**
 * Claim the single Runtime Computer slot for a project. The
 * `unique (project_id)` constraint makes this the concurrency gate for lazy
 * provisioning: two "New Workspace" clicks race here and exactly one insert
 * wins. The loser gets a unique-violation, catches it, and reads the existing
 * row via {@link getRuntimeComputerByProject}.
 */
export async function createRuntimeComputer(input: {
  ownerId: string;
  projectId: string;
  agentSecret: string;
  imageVersion?: string;
}): Promise<RuntimeComputer> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .insert({
      owner_id: input.ownerId,
      project_id: input.projectId,
      agent_secret: input.agentSecret,
      status: "provisioning",
      ...(input.imageVersion && { image_version: input.imageVersion }),
    })
    .select("*")
    .single();

  if (error) throw error;
  return toRuntimeComputer(data);
}

/**
 * Atomically claim the box of `scope`: a workspace's own
 * (claim_workspace_computer), or a project's shared one from before
 * (claim_runtime_computer). Each SQL function takes a transaction-scoped
 * advisory lock before reading/inserting, while a unique index remains the
 * durable backstop.
 */
export async function claimRuntimeComputer(input: {
  scope: ComputerScope;
  agentSecret: string;
  /** The plan's cap on the owner's running boxes, enforced by the claim in
   *  the database (20261019140000_plan_box_limits.sql); null or unset when
   *  none applies. */
  maxLiveComputers?: number | null;
}): Promise<{ computer: RuntimeComputer; shouldProvision: boolean }> {
  const supabase = await createSupabaseServerClient();
  const { scope } = input;
  const call = (withCap: boolean) =>
    "workspaceId" in scope
      ? supabase.rpc("claim_workspace_computer", {
          requested_workspace_id: scope.workspaceId,
          requested_agent_secret: input.agentSecret,
          max_live_computers: input.maxLiveComputers ?? null,
        })
      : supabase.rpc("claim_runtime_computer", {
          requested_project_id: scope.projectId,
          requested_agent_secret: input.agentSecret,
          ...(withCap && { max_live_computers: input.maxLiveComputers ?? null }),
        });

  let { data, error } = await call(input.maxLiveComputers !== undefined);
  // Before 20261019140000 takes the argument, the project's claim still
  // works, uncapped, until the migration is run.
  if (error && !("workspaceId" in scope) && input.maxLiveComputers !== undefined && error.code === "PGRST202") {
    console.warn("claim_runtime_computer without the plan's box cap: run the migrations");
    ({ data, error } = await call(false));
  }

  if (error) throw error;
  const claim = data?.[0];
  if (!claim || !data || data.length !== 1) {
    throw new Error("Runtime Computer claim returned an invalid result.");
  }
  const computer = await getRuntimeComputer(scope);
  if (!computer || computer.id !== claim.runtime_computer_id) {
    throw new Error("Runtime Computer claim was not persisted.");
  }
  return { computer, shouldProvision: claim.should_provision };
}

/**
 * Hand the project's pooled box (lib/runtime/warm-pool.ts), made by
 * `provider`, to a session with no box yet: it becomes the session's own,
 * still stopped, for its setup to start again. The box's id, or null when
 * there's none to take, or before the warm pool's migration.
 */
export async function claimPooledComputer(
  workspaceId: string,
  provider: ProviderName,
  /** Only a box made from this generation of the project's setup; null: any. */
  generation: number | null = null,
): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("claim_pooled_computer", {
    requested_workspace_id: workspaceId,
    requested_provider: provider,
    ...(generation !== null && { requested_generation: generation }),
  });
  // Before the migration: no function to call, or no column. No pool, then.
  if (error && (error.code === "PGRST202" || error.code === "42883" || probeStatus(error) === "outdated")) {
    console.warn("No warm pool yet: run the migrations", error.message);
    return null;
  }
  if (error) throw error;
  return typeof data === "string" ? data : null;
}

/** Start or extend a short wake-up lease on one of the project's pooled
 * boxes. Null means there is no ready pooled box to warm. The database owns
 * the plan-cap check and stopped -> provisioning transition atomically. */
export async function claimPooledWarmup(input: {
  projectId: string;
  provider: ProviderName;
  generation: number | null;
  maxLiveComputers: number | null;
}): Promise<{ computerId: string; shouldWake: boolean } | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("claim_pooled_warmup", {
    requested_project_id: input.projectId,
    requested_provider: input.provider,
    ...(input.generation !== null && { requested_generation: input.generation }),
    max_live_computers: input.maxLiveComputers,
  });
  // A deploy before the migration simply cannot intent-warm; Send retains
  // the existing stopped-pool/cold provisioning path.
  if (error && (error.code === "PGRST202" || error.code === "42883" || probeStatus(error) === "outdated")) {
    console.warn("No intent warm pool yet: run the migrations", error.message);
    return null;
  }
  if (error) throw error;
  const claim = data?.[0];
  return claim ? { computerId: claim.runtime_computer_id, shouldWake: claim.should_wake } : null;
}

/** A member's pooled boxes of the project, in whatever state: each member
 *  of an org has their own (20261028120000). */
export async function getPooledComputers(projectId: string, ownerId: string): Promise<RuntimeComputer[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .select("*")
    .eq("project_id", projectId)
    .eq("owner_id", ownerId)
    .eq("pooled", true);
  if (error) throw error;
  return (data ?? []).map(toRuntimeComputer);
}

/** Start a pooled box's row in `slot`: null when the slot is taken (the
 *  unique index says so), so two refills make one box a slot. */
export async function createPooledComputer(input: {
  ownerId: string;
  projectId: string;
  provider: ProviderName;
  agentSecret: string;
  slot: number;
  generation: number | null;
}): Promise<RuntimeComputer | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .insert({
      owner_id: input.ownerId,
      project_id: input.projectId,
      provider: input.provider,
      agent_secret: input.agentSecret,
      status: "provisioning",
      pooled: true,
      pool_slot: input.slot,
      ...(input.generation !== null && { generation: input.generation }),
    })
    .select("*")
    .single();
  // One there already, or no pool before the migration.
  if (error?.code === "23505" || (error && probeStatus(error) === "outdated")) return null;
  if (error) throw error;
  return toRuntimeComputer(data);
}

/** Record the pooled box stopped and ready to take; false when its row is
 *  gone (swept as abandoned), so the box is its refill's to delete. */
export async function markPooledReady(id: string, sandboxId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .update({ status: "stopped", daytona_sandbox_id: sandboxId, error_message: null })
    .eq("id", id)
    .eq("pooled", true)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Publish an intent wake while its lease is live or after Send took it. If
 * expiry cleanup owns the row, persist the fresh endpoint without exposing
 * it until that provider pause succeeds or fails. */
export async function completePooledWarmup(
  id: string,
  restored: {
    sandboxId: string;
    provider: ProviderName;
    agentBaseUrl: string;
    timings: ProvisionTimings;
  },
): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("complete_pooled_warmup", {
    requested_computer_id: id,
    requested_sandbox_id: restored.sandboxId,
    requested_provider: restored.provider,
    requested_agent_base_url: restored.agentBaseUrl,
    requested_timings: restored.timings,
  });
  if (error) throw error;
  return data;
}

/** Mark a pooled box's refill failed, for the project's back-off, keeping the
 *  box its delete couldn't remove (`leftover`), so the next refill deletes it. */
export async function markPooledFailed(id: string, leftover: string | null): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("runtime_computers")
    .update({ status: "error", daytona_sandbox_id: leftover, agent_base_url: null, error_message: "The warm pool's refill failed." })
    .eq("id", id)
    .eq("pooled", true);
  if (error) throw error;
}

/** Take a box out of the pool: its row deleted only while still pooled.
 *  False when a session claimed it first (its row is no longer pooled). */
export async function releasePooledComputer(id: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("runtime_computers").delete().eq("id", id).eq("pooled", true).select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Forget a pooled box's row whose box couldn't be made. */
export async function deletePooledComputer(id: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("runtime_computers").delete().eq("id", id).eq("pooled", true);
  if (error) throw error;
}

export async function updateRuntimeComputer(
  id: string,
  patch: {
    status?: RuntimeComputerStatus;
    daytonaSandboxId?: string | null;
    provider?: ProviderName;
    agentBaseUrl?: string | null;
    provisionTimings?: ProvisionTimings | null;
    errorMessage?: string | null;
    warmExpiresAt?: string | null;
    touchActive?: boolean;
  },
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const update = (withProvider: boolean) =>
    supabase
      .from("runtime_computers")
      .update({
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.daytonaSandboxId !== undefined && {
          daytona_sandbox_id: patch.daytonaSandboxId,
        }),
        ...(withProvider && patch.provider !== undefined && { provider: patch.provider }),
        ...(patch.agentBaseUrl !== undefined && {
          agent_base_url: patch.agentBaseUrl,
        }),
        ...(patch.provisionTimings !== undefined && {
          provision_timings: patch.provisionTimings,
        }),
        ...(patch.errorMessage !== undefined && {
          error_message: patch.errorMessage,
        }),
        ...(patch.warmExpiresAt !== undefined && {
          warm_expires_at: patch.warmExpiresAt,
        }),
        ...(patch.touchActive && { last_active_at: new Date().toISOString() }),
      })
      .eq("id", id);

  let { error } = await update(true);
  // Before 20261013120000_user_sandbox.sql adds the column, the provider isn't
  // recorded (the deployment's is assumed); the rest still is.
  if (error && patch.provider !== undefined && probeStatus(error) === "outdated") {
    ({ error } = await update(false));
  }
  if (error) throw error;
}

/**
 * Mark a ready Runtime Computer stopped only if it still refers to the exact
 * Daytona sandbox we just found unavailable. The compare-and-set guards the
 * lazy-provisioning claim: two simultaneous New Workspace requests can both
 * observe a dead box, but only one is allowed to make it retryable.
 */
export async function markRuntimeComputerStoppedIfReady(
  id: string,
  daytonaSandboxId: string,
): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .update({
      status: "stopped",
      error_message: "Runtime Computer is no longer available and will be reprovisioned.",
    })
    .eq("id", id)
    .eq("status", "ready")
    .eq("daytona_sandbox_id", daytonaSandboxId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

/**
 * Read the server-only per-computer secret used to mint Runtime tokens. Kept
 * out of the domain object (see {@link toRuntimeComputer}) so it never rides
 * along into a browser-facing payload; callers ask for it explicitly.
 */
export async function readRuntimeComputerSecret(
  id: string,
): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .select("agent_secret")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data?.agent_secret ?? null;
}

// --- jobs ------------------------------------------------------------------

export async function listJobs(workspaceId: string): Promise<Job[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toJob);
}

export async function getJob(id: string): Promise<Job | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data ? toJob(data) : null;
}

export async function createJobRow(input: {
  ownerId: string;
  workspaceId: string;
  agent: JobAgent;
  prompt: string;
  linearIssueId?: string | null;
}): Promise<Job> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      owner_id: input.ownerId,
      workspace_id: input.workspaceId,
      agent: input.agent,
      prompt: input.prompt,
      linear_issue_id: input.linearIssueId ?? null,
      status: "queued",
    })
    .select("*")
    .single();

  if (error) throw error;
  return toJob(data);
}

export async function updateJob(
  id: string,
  patch: {
    status?: JobStatus;
    logPath?: string | null;
    resultPath?: string | null;
    executionHandle?: string | null;
    logBytes?: number;
    exitCode?: number | null;
    sessionId?: string | null;
    costUsd?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  },
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("jobs")
    .update({
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.logPath !== undefined && { log_path: patch.logPath }),
      ...(patch.resultPath !== undefined && { result_path: patch.resultPath }),
      ...(patch.executionHandle !== undefined && {
        execution_handle: patch.executionHandle,
      }),
      ...(patch.logBytes !== undefined && { log_bytes: patch.logBytes }),
      ...(patch.exitCode !== undefined && { exit_code: patch.exitCode }),
      ...(patch.sessionId !== undefined && { session_id: patch.sessionId }),
      ...(patch.costUsd !== undefined && { cost_usd: patch.costUsd }),
      ...(patch.startedAt !== undefined && { started_at: patch.startedAt }),
      ...(patch.finishedAt !== undefined && { finished_at: patch.finishedAt }),
    })
    .eq("id", id);

  if (error) throw error;
}

/** Atomically claim or complete a job only while it is in an expected state. */
export async function transitionJob(input: {
  id: string;
  from: JobStatus[];
  patch: {
    status: JobStatus;
    logPath?: string | null;
    resultPath?: string | null;
    executionHandle?: string | null;
    logBytes?: number;
    exitCode?: number | null;
    sessionId?: string | null;
    costUsd?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  };
}): Promise<Job | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .update({
      status: input.patch.status,
      ...(input.patch.logPath !== undefined && { log_path: input.patch.logPath }),
      ...(input.patch.resultPath !== undefined && { result_path: input.patch.resultPath }),
      ...(input.patch.executionHandle !== undefined && {
        execution_handle: input.patch.executionHandle,
      }),
      ...(input.patch.logBytes !== undefined && { log_bytes: input.patch.logBytes }),
      ...(input.patch.exitCode !== undefined && { exit_code: input.patch.exitCode }),
      ...(input.patch.sessionId !== undefined && { session_id: input.patch.sessionId }),
      ...(input.patch.costUsd !== undefined && { cost_usd: input.patch.costUsd }),
      ...(input.patch.startedAt !== undefined && { started_at: input.patch.startedAt }),
      ...(input.patch.finishedAt !== undefined && { finished_at: input.patch.finishedAt }),
    })
    .eq("id", input.id)
    .in("status", input.from)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? toJob(data) : null;
}

/** The session's pull request in `projectId`, a repository of it (a session
 *  of several has one in each). */
export async function getWorkspacePullRequest(
  workspaceId: string,
  projectId: string,
): Promise<WorkspacePullRequest | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pull_requests")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw error;
  return data ? toWorkspacePullRequest(data) : null;
}

/** The pull requests of these workspaces, in one query. */
export async function listWorkspacePullRequests(workspaceIds: string[]): Promise<WorkspacePullRequest[]> {
  if (workspaceIds.length === 0) return [];
  const supabase = await createSupabaseServerClient();
  // Oldest first: callers that keep one a session keep its first.
  const { data, error } = await supabase
    .from("pull_requests")
    .select("*")
    .in("workspace_id", workspaceIds)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(toWorkspacePullRequest);
}

export async function createWorkspacePullRequest(input: {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
}): Promise<WorkspacePullRequest> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pull_requests")
    .insert({
      owner_id: input.ownerId,
      workspace_id: input.workspaceId,
      project_id: input.projectId,
      github_number: input.number,
      url: input.url,
      title: input.title,
      base_branch: input.baseBranch,
      head_branch: input.headBranch,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toWorkspacePullRequest(data);
}

/** Point a session's recorded pull request in one repository at another
 *  (one that took over from it), and return it as recorded now. */
export async function relinkWorkspacePullRequest(
  id: string,
  ref: { number: number; url: string; title: string; baseBranch: string },
): Promise<WorkspacePullRequest> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pull_requests")
    .update({ github_number: ref.number, url: ref.url, title: ref.title, base_branch: ref.baseBranch })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return toWorkspacePullRequest(data);
}

// --- snapshots -------------------------------------------------------------

/** A workspace's Snapshots, newest first (the Replay picker's list). */
export async function listWorkspaceSnapshots(
  workspaceId: string,
): Promise<WorkspaceSnapshot[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("archived_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toWorkspaceSnapshot);
}

/** One Snapshot by id, or null. RLS confines the read to the owner. */
export async function getWorkspaceSnapshot(
  id: string,
): Promise<WorkspaceSnapshot | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_snapshots")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? toWorkspaceSnapshot(data) : null;
}

/** Remove a workspace's Snapshot index rows (terminal destroy cleanup). */
export async function deleteWorkspaceSnapshots(workspaceId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("workspace_snapshots")
    .delete()
    .eq("workspace_id", workspaceId);
  if (error) throw error;
}

/**
 * Insert the DERIVED index row for a Workspace Snapshot after the agent has
 * uploaded its artifacts (manifest last). The canonical Snapshot lives in
 * storage; this row caches the manifest for cheap listing and carries the
 * retention `policy` (v0 always `manual_only`). `archivedAt` and `storagePath`
 * must be the same values Next used to mint the upload URLs, so the row and the
 * stored objects agree.
 */
export async function createWorkspaceSnapshot(input: {
  ownerId: string;
  workspaceId: string;
  archivedAt: string;
  storagePath: string;
  manifest: SnapshotManifest;
  policy?: ArchivePolicy;
  retentionDays?: number | null;
}): Promise<WorkspaceSnapshot> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_snapshots")
    .insert({
      owner_id: input.ownerId,
      workspace_id: input.workspaceId,
      archived_at: input.archivedAt,
      storage_path: input.storagePath,
      manifest: input.manifest,
      policy: input.policy ?? "manual_only",
      retention_days: input.retentionDays ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toWorkspaceSnapshot(data);
}
