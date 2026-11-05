/**
 * Real wiring for the warm pool (lib/runtime/warm-pool.ts). Kept apart so the
 * rules stay free of the database and unit-testable.
 */

import { randomBytes } from "node:crypto";

import type { Owner } from "@/lib/auth/owner";
import { SMALL_BOX_CPU } from "@/lib/billing/hours";
import { cloudBoxStartGate } from "@/lib/billing/limits";
import { closeIntervalOf, isMetered, openInterval } from "@/lib/billing/metering-store";
import { getSandboxSettings, ownSandboxKeys } from "@/lib/db/credentials";
import {
  defaultEnvironmentId,
  environmentSetup,
  getEnvironment,
  recordWarmRun,
  sessionCheckouts,
  setupGeneration,
} from "@/lib/db/environments";
import { gitTokensFor, optionalGitToken } from "@/lib/github/identity.deps";
import {
  claimPooledComputer,
  claimPooledWarmup,
  completePooledWarmup,
  createPooledComputer,
  deletePooledComputer,
  getPooledComputers,
  getProject,
  getRuntimeComputerById,
  readRuntimeComputerSecret,
  releasePooledComputer,
  markPooledFailed,
  markPooledReady,
  updateRuntimeComputer,
} from "@/lib/db/repositories";
import { AgentClient, AgentRequestError } from "@/lib/runtime/agent-client";
import { LISTING_WORKSPACE_ID, type WarmRequest } from "@/lib/runtime/agent-protocol";
import { type ComputerRuntimeProvider, isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerForNewSessions, providerNamed } from "@/lib/runtime/sandbox-choice";
import { runtimeSessionEnvironment } from "@/lib/runtime/session-environment";
import type { Project, ProviderName } from "@/lib/runtime/types";
import {
  POOL_SIZE,
  pauseExpiredIntentWarmup,
  projectCheckouts,
  refillPool,
  STALE_REFILL_MS,
  wakeIntentPool,
  warmRefusal,
} from "@/lib/runtime/warm-pool";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Whether `provider`'s boxes are pooled: Outrunner's own, on a provider
 *  that pauses a box and brings it back on its disk. */
export function poolsBoxes(provider: ComputerRuntimeProvider): boolean {
  return provider.pausesBoxes && provider.restoresBoxes && isMetered(provider.name);
}

/** How long a composer intent keeps an otherwise unused pooled box running. */
export const INTENT_WARM_MS = 90_000;

/**
 * Wake one prepared box while the user is composing a new session. Best
 * effort: Send always retains the ordinary stopped-pool/cold path.
 *
 * The database claim is the handoff point. A Send may turn the row from
 * pooled into the workspace's own while provisionComputer is restoring it;
 * both then wait on/update the same computer id and secret.
 */
export async function intentWarmProject(owner: Owner, projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) return;

  const settings = await getSandboxSettings(owner.id);
  const provider = providerForNewSessions(settings, ownSandboxKeys(owner.id));
  if (!isComputerProvider(provider) || !poolsBoxes(provider)) return;

  // A repeated intent extends this project's existing reservation even when
  // it currently occupies the plan's final slot.
  const gate = await cloudBoxStartGate(owner, project.orgId, provider.name, {
    warmProjectId: project.id,
  });
  if ("denial" in gate) return;

  const environmentId = await defaultEnvironmentId(owner.id, project.id).catch(() => null);
  const [generation, githubToken, sessionEnv] = await Promise.all([
    setupGeneration(owner.id, environmentId).catch(() => null),
    optionalGitToken(owner.id, { orgId: project.orgId, fullName: project.fullName }),
    runtimeSessionEnvironment(owner.id, null),
  ]);

  const claim = () => claimPooledWarmup({
    projectId: project.id,
    provider: provider.name,
    generation,
    maxLiveComputers: gate.cap,
  });
  let warm = await claim();
  // A project's first composer can prepare its pool too. If Send wins this
  // race it simply takes the cold path; the refill remains useful next time.
  if (!warm) {
    await refillProjectPool({
      provider,
      ownerId: owner.id,
      project,
      environmentId,
      githubToken,
      sessionEnv,
    });
    warm = await claim();
  }
  if (!warm?.shouldWake) return;

  const computer = await getRuntimeComputerById(warm.computerId);
  const secret = await readRuntimeComputerSecret(warm.computerId);
  const sandboxId = computer?.daytonaSandboxId;
  if (!computer || !sandboxId || !secret) return;

  await wakeIntentPool({
    wake: () => provider.provisionComputer({
      secret,
      repoFullName: project.fullName,
      githubToken,
      sessionEnv,
      previousSandboxId: sandboxId,
    }),
    publish: (restored) => completePooledWarmup(owner.id, computer.id, {
      sandboxId: restored.sandboxId,
      provider: provider.name,
      agentBaseUrl: restored.agentBaseUrl,
      timings: restored.timings,
    }),
    meter: (restored) => openInterval({
      computerId: computer.id,
      sandboxId: restored.sandboxId,
      cpu: restored.cpu ?? SMALL_BOX_CPU,
      at: new Date(),
    }),
    meterFailed: (error) =>
      console.error(`Could not meter intent-warmed box ${computer.id}; reconciliation will retry`, error),
    pause: (restored) => provider.pauseComputer(restored.sandboxId),
    stopped: () => updateRuntimeComputer(computer.id, owner.id, {
      status: "stopped",
      warmExpiresAt: null,
      errorMessage: "The session pre-warm did not finish; Send can try again.",
    }),
  });
}

/** A pooled box of the project for a new session to take, made by
 *  `provider` from `generation` of the project's setup: its id, or null when
 *  there's none (and so the session makes its own). */
export async function takePooledBox(
  provider: ComputerRuntimeProvider,
  workspaceId: string,
  generation: number | null,
): Promise<string | null> {
  if (!poolsBoxes(provider)) return null;
  try {
    return await claimPooledComputer(workspaceId, provider.name, generation);
  } catch (error) {
    console.error(`Could not take a pooled box for ${workspaceId}`, error);
    return null;
  }
}

/** How often a warming box is asked how it's going, and how long it may
 *  take: the agent's own hour, and room for the box to answer. */
const WARM_POLL_MS = 5_000;
const WARM_WAIT_MS = 65 * 60_000;

/** How many times a just-made box's health is checked before it's pooled
 *  unwarmed, and the pause between tries. */
const HEALTH_TRIES = 5;
const HEALTH_RETRY_MS = 3_000;

/** Status calls that may fail in a row before a warming box is given up. */
const WARM_STATUS_MISSES = 3;

/** The end of a warm log kept for the settings page. */
const WARM_LOG_KEPT = 64 * 1024;

/** Fill the project's pool, for its next sessions: each box made, warmed
 *  with the project's setup and stopped. Best effort, after a session's setup
 *  or a change to the project: it never throws. */
export async function refillProjectPool(input: {
  provider: ComputerRuntimeProvider;
  ownerId: string;
  project: Pick<Project, "id" | "orgId" | "fullName" | "defaultBranch">;
  /** The project (an `environments` row) whose setup the boxes are warmed
   *  with; null makes them unwarmed, as before projects. */
  environmentId: string | null;
  githubToken?: string;
  sessionEnv: Record<string, string>;
}): Promise<void> {
  const { provider, ownerId, project, environmentId } = input;
  try {
    const setup = environmentId ? await environmentSetup(ownerId, environmentId) : null;
    const generation = setup?.generation ?? null;
    await refillPool({
      pools: poolsBoxes(provider),
      provider: provider.name,
      size: POOL_SIZE,
      generation,
      pooled: () => getPooledComputers(project.id, ownerId),
      claimSlot: (slot, secret) =>
        createPooledComputer({ ownerId, projectId: project.id, provider: provider.name, agentSecret: secret, slot, generation }),
      make: (secret, onBox) =>
        provider.provisionComputer({
          secret,
          repoFullName: project.fullName,
          githubToken: input.githubToken,
          sessionEnv: input.sessionEnv,
          onBox,
        }),
      warm: async (computerId, sandboxId, secret) => {
        if (!setup || !environmentId) return;
        const hook = setup.hooks?.warm ?? "";
        if (!hook && Object.keys(setup.files).length === 0) return; // nothing to warm with
        // A project of several repositories is warmed in the folder its
        // sessions work in, each repository's mirror on the box first, as a
        // session syncs them; its own repository from its default branch, as
        // a new session's is.
        const checkouts = projectCheckouts(await sessionCheckouts(ownerId, environmentId), project.id, project.defaultBranch);
        const repos = checkouts?.map((c) => ({ fullName: c.fullName, checkout: c.checkout, baseBranch: c.baseBranch }));
        const agent = new AgentClient(await provider.agentTarget(sandboxId, secret));
        await warmBox(agent, { projectId: project.id, computerId, userId: ownerId }, environmentId, {
          baseBranch: repos?.[0].baseBranch ?? project.defaultBranch,
          env: setup.env,
          files: setup.files,
          hook,
          generation,
          ...(repos && {
            severalRepos: { repos, sync: () => provider.syncRepoMirrors(sandboxId, repos, gitTokensFor(ownerId, project.orgId)) },
          }),
        });
      },
      recordBox: (computerId, sandboxId) => updateRuntimeComputer(computerId, ownerId, { daytonaSandboxId: sandboxId }),
      pause: (sandboxId) => provider.pauseComputer(sandboxId),
      ready: (id, sandboxId) => markPooledReady(id, ownerId, sandboxId),
      failed: (id, leftover) => markPooledFailed(id, ownerId, leftover),
      discard: (sandboxId, madeBy) => discardBox(provider, madeBy, ownerId, sandboxId),
      forget: (id) => deletePooledComputer(id, ownerId),
      release: (id) => releasePooledComputer(id, ownerId),
      leftover: async (box, sandboxId) => {
        // The box's own maker and generation: an outdated one is retried at
        // the next refill rather than backing the project off, and a foreign
        // one stays the sweeper's to log for deleting by hand.
        const row = await createPooledComputer({
          ownerId,
          projectId: project.id,
          provider: box.provider ?? provider.name,
          agentSecret: randomBytes(32).toString("hex"),
          slot: box.poolSlot,
          generation: box.generation,
        });
        if (!row) throw new Error(`slot ${box.poolSlot} is taken`);
        await markPooledFailed(row.id, ownerId, sandboxId);
      },
      newSecret: () => randomBytes(32).toString("hex"),
      now: Date.now,
    });
  } catch (error) {
    console.error(`Could not make ${project.fullName}'s pooled boxes`, error);
  }
}

/** Why a health check failed, for the settings page's log: the error's own
 *  words (an agent's refusal, a network failure and its cause), short. */
function whyNot(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 200);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`.slice(0, 300);
}

/** Whether a failed health check is one a box still booting gives. */
function stillBooting(error: unknown): boolean {
  return !(error instanceof AgentRequestError) || error.status >= 500 || error.status === 429;
}

/** A warm hook that failed: its exit code, and its log on the project. */
export class WarmHookError extends Error {}

/** Warm a ready box and wait for it, the run recorded on the project as it
 *  goes. A project of several repositories (`severalRepos`) has their mirrors
 *  synced onto the box first (its `sync`). Throws when the hook fails or
 *  outlasts its time. */
async function warmBox(
  agent: AgentClient,
  box: { projectId: string; computerId: string; userId: string },
  environmentId: string,
  req: {
    baseBranch: string;
    env: Record<string, string>;
    files: Record<string, string>;
    hook: string;
    generation: number | null;
    severalRepos?: { repos: NonNullable<WarmRequest["repos"]>; sync: () => Promise<void> };
  },
): Promise<void> {
  // Box-wide, as the warm itself is: a box no session has yet answers for
  // the listing id. A box just made may take a moment to answer.
  let healthError: unknown = null;
  let health: Awaited<ReturnType<AgentClient["health"]>> | null = null;
  for (let attempt = 0; attempt < HEALTH_TRIES; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
    try {
      health = await agent.health({ ...box, workspaceId: LISTING_WORKSPACE_ID });
      break;
    } catch (error) {
      healthError = error;
      // Only what a box still booting answers is tried again (no answer,
      // the proxy's 5xx or 429): a refusal or a bug fails at once.
      if (!stillBooting(error)) break;
    }
  }
  const refusal = health ? warmRefusal(health.features, req.severalRepos !== undefined) : null;
  if (!health || refusal) {
    // An older agent (or one that didn't answer): pooled unwarmed, and the
    // session that takes it runs the warm hook itself as it starts. Recorded,
    // so the settings page says so rather than "Applying" until it's updated.
    console.warn(`Box ${box.computerId}'s agent can't run a warm hook: pooled unwarmed`, healthError ?? "");
    const at = new Date().toISOString();
    await recordWarmRun(environmentId, box.userId, {
      status: "failed",
      log:
        refusal ??
        `The ready box didn't answer before its warm hook could start (${whyNot(healthError)}). Sessions run the warm hook themselves as they start.`,
      startedAt: at,
      finishedAt: at,
      generation: req.generation,
    }).catch(() => {});
    return;
  }
  const startedAt = new Date().toISOString();
  const failed = (log: string) =>
    recordWarmRun(environmentId, box.userId, { status: "failed", log, startedAt, finishedAt: new Date().toISOString(), generation: req.generation });
  await recordWarmRun(environmentId, box.userId, { status: "running", log: null, startedAt, finishedAt: null, generation: req.generation });
  if (req.severalRepos) {
    try {
      await req.severalRepos.sync();
    } catch (error) {
      await failed(`The project's repositories couldn't be cloned onto the box: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
      throw error;
    }
  }
  try {
    await agent.startWarm(box, {
      baseBranch: req.baseBranch,
      env: req.env,
      files: req.files,
      hook: req.hook,
      ...(req.severalRepos && { repos: req.severalRepos.repos }),
    });
  } catch (error) {
    await failed(`The warm hook couldn't be started: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    throw error;
  }
  const deadline = Date.now() + WARM_WAIT_MS;
  let misses = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, WARM_POLL_MS));
    let status;
    try {
      status = await agent.warmStatus(box);
      misses = 0;
    } catch (error) {
      // A blip doesn't end a run that may be going fine: a few in a row do.
      if (++misses < WARM_STATUS_MISSES && Date.now() < deadline) continue;
      await failed(`The box stopped answering while its warm hook ran: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
      throw error;
    }
    if (status.state === "running" && Date.now() < deadline) continue;
    const ok = status.state === "succeeded";
    await recordWarmRun(environmentId, box.userId, {
      status: ok ? "succeeded" : "failed",
      log: (status.log ?? "").slice(-WARM_LOG_KEPT) || null,
      startedAt,
      finishedAt: status.finishedAt ?? new Date().toISOString(),
      generation: req.generation,
    });
    if (ok) return;
    throw new WarmHookError(
      status.state === "running" ? "The warm hook ran past its hour." : `The warm hook failed (exit ${status.exitCode ?? "?"}).`,
    );
  }
}

/** Delete a pooled box with the provider that made it. Pooled boxes are only
 *  ever the deployment's, so another maker means the deployment's provider
 *  changed: that one can't be reached from here, and its row can't help
 *  delete it, so the box is logged (to delete by hand) and let go. */
async function discardBox(
  provider: ComputerRuntimeProvider,
  madeBy: ProviderName | null,
  ownerId: string,
  sandboxId: string,
): Promise<void> {
  const maker = !madeBy || madeBy === provider.name ? provider : providerNamed(madeBy, ownSandboxKeys(ownerId));
  if (!maker || !isComputerProvider(maker)) {
    console.warn(`Pooled box ${sandboxId} on ${madeBy} can't be reached to delete it: delete it there by hand`);
    return;
  }
  await maker.destroyComputerOrThrow(sandboxId);
}

/**
 * Delete the warm pool's boxes nothing else will: a refill that died mid-way
 * (its row still "provisioning" past STALE_REFILL_MS, its box maybe running),
 * and a failed refill's leftover box (an "error" row that kept the box its
 * delete couldn't remove; maybe still running too). Pooled boxes are outside
 * metering and the reconciler, so this is what stops them. For the
 * reconciler's cron, so such a box lasts minutes, not until the project's
 * next session. A dead refill's row goes; a failed one keeps its row, for its
 * back-off, without the box. How many boxes went. A box already gone is gone.
 */
export async function sweepAbandonedPools(provider: ComputerRuntimeProvider): Promise<number> {
  const supabase = createSupabaseAdminClient();
  const stale = new Date(Date.now() - STALE_REFILL_MS).toISOString();
  const { data, error } = await supabase
    .from("runtime_computers")
    .select("id, status, daytona_sandbox_id, provider")
    .eq("pooled", true)
    .or(`and(status.eq.provisioning,updated_at.lt.${stale}),and(status.eq.error,daytona_sandbox_id.not.is.null)`);
  if (error) throw error;
  let swept = 0;
  for (const row of data ?? []) {
    try {
      // Pooled boxes are only ever this deployment's provider's: another's
      // means the deployment moved, and its box can't be reached from here.
      if (row.daytona_sandbox_id && row.provider && row.provider !== provider.name) {
        console.warn(`Pooled box ${row.daytona_sandbox_id} on ${row.provider} can't be reached to delete it: delete it there by hand`);
      } else if (row.daytona_sandbox_id) {
        await provider.destroyComputerOrThrow(row.daytona_sandbox_id);
      }
      const { error: writeError } =
        row.status === "error"
          ? await supabase.from("runtime_computers").update({ daytona_sandbox_id: null }).eq("id", row.id).eq("pooled", true)
          : await supabase.from("runtime_computers").delete().eq("id", row.id).eq("pooled", true);
      if (writeError) throw writeError;
      swept += 1;
    } catch (sweepError) {
      console.error(`Could not sweep pooled box ${row.id}`, sweepError);
    }
  }
  return swept;
}

/** Pause intent-warmed pool boxes whose composer never sent. The conditional
 * update claims each row before any provider call: if Send claimed it first,
 * `pooled` is already false and it is untouched. The cleanup flag keeps a
 * failed/in-flight pause ineligible to Send until the wake endpoint is
 * durable or the provider confirms the box stopped. */
export async function sweepExpiredIntentWarmups(
  provider: ComputerRuntimeProvider,
  now = new Date(),
): Promise<number> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .update({
      status: "provisioning",
      warm_expires_at: null,
      warm_cleanup_pending: true,
      error_message: "Pausing an unused session pre-warm.",
    })
    .eq("pooled", true)
    .eq("provider", provider.name)
    .in("status", ["provisioning", "ready"])
    .not("warm_expires_at", "is", null)
    .lte("warm_expires_at", now.toISOString())
    .select("id, daytona_sandbox_id");
  if (error) throw error;

  let paused = 0;
  for (const row of data ?? []) {
    const sandboxId = row.daytona_sandbox_id;
    if (!sandboxId) continue;
    try {
      const didPause = await pauseExpiredIntentWarmup({
        pause: () => provider.pauseComputer(sandboxId),
        closeMetering: () => closeIntervalOf(sandboxId, now),
        closeMeteringFailed: (meterError) =>
          console.error(`Could not close metering for paused warm-pool box ${row.id}; reconciliation will retry`, meterError),
        stopped: async () => {
          const { error: updateError } = await supabase
            .from("runtime_computers")
            .update({ status: "stopped", warm_cleanup_pending: false, error_message: null })
            .eq("id", row.id)
            .eq("pooled", true)
            .eq("status", "provisioning")
            .eq("warm_cleanup_pending", true);
          if (updateError) throw updateError;
        },
        pauseFailed: async (pauseError) => {
          // Keep it metered and retry after another short lease. The row
          // stays cleanup-owned until its fresh endpoint is durable.
          const { error: retryError } = await supabase.rpc("retry_pooled_warmup_pause", {
            requested_computer_id: row.id,
            retry_at: new Date(now.getTime() + INTENT_WARM_MS).toISOString(),
          });
          if (retryError) console.error(`Could not restore warm-pool row ${row.id} after pause failed`, retryError);
          console.error(`Could not pause expired warm-pool box ${row.id}`, pauseError);
        },
      });
      if (didPause) paused += 1;
    } catch (settleError) {
      // The provider pause succeeded, so never restore ready here. Leaving
      // cleanup_pending set keeps Send fenced until a later repair.
      console.error(`Could not record paused warm-pool box ${row.id}`, settleError);
    }
  }
  return paused;
}

/**
 * Make the ready boxes of the member who changed the project again after a
 * change they're made from (its warm hook, variables or files; "Try again"):
 * those of the old setup are replaced. Only theirs: each member has their
 * own pool (20261028120000), made with their GitHub token and written only
 * by them (runtime_computers' policy). Another member's boxes of the old
 * setup are never taken (claim_pooled_computer asks for the current
 * generation), so their next session starts cold, and its setup refills
 * their pool. Only for a repository whose sessions are pooled already. Best
 * effort, after the change is saved: it never throws.
 */
export async function refillAfterChange(ownerId: string, environmentId: string): Promise<void> {
  try {
    const environment = await getEnvironment(ownerId, environmentId);
    const repo = environment?.repos[0];
    if (!repo || (await getPooledComputers(repo.projectId, ownerId)).length === 0) return;
    const provider = providerForNewSessions(await getSandboxSettings(ownerId), ownSandboxKeys(ownerId));
    if (!isComputerProvider(provider)) return;
    await refillProjectPool({
      provider,
      ownerId,
      project: { id: repo.projectId, orgId: environment.orgId, fullName: repo.fullName, defaultBranch: repo.defaultBranch },
      environmentId,
      githubToken: await optionalGitToken(ownerId, { orgId: environment.orgId, fullName: repo.fullName }),
      sessionEnv: await runtimeSessionEnvironment(ownerId, null),
    });
  } catch (error) {
    console.error(`Could not make project ${environmentId}'s ready boxes again`, error);
  }
}
