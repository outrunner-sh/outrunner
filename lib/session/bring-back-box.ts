/**
 * A session's box brought back when it ended: paused while idle
 * (lib/billing/reconcile.ts), stopped or archived on the provider, or gone,
 * when a new one is started in its place. Opening the session
 * (app/api/workspaces/[id]/session) and resuming it (the lifecycle route's
 * resume) both start here, so neither runs on a box that isn't up.
 */

import type { Owner } from "@/lib/auth/owner";
import { sessionPlan } from "@/lib/billing/entitlements";
import { cloudBoxStartGate, CloudLimitError } from "@/lib/billing/limits";
import { getSandboxSettings } from "@/lib/db/credentials";
import { orgDefaultsFor } from "@/lib/db/org-defaults";
import { getProject, markRuntimeComputerStoppedIfReady } from "@/lib/db/repositories";
import { optionalGitToken, sessionGitAs } from "@/lib/github/identity.deps";
import { newBoxSize } from "@/lib/orgs/defaults";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { scopeOf } from "@/lib/runtime/computer-scope";
import { ensureComputer } from "@/lib/runtime/runtime-computer-service";
import { boxSizeOn, computerMadeBy, endedBoxOf, sandboxOf } from "@/lib/runtime/sandbox-choice";
import { runtimeSessionEnvironment } from "@/lib/runtime/session-environment";
import type { RuntimeComputer, Workspace } from "@/lib/runtime/types";

/**
 * The session's computer (its own box, or its project's shared one) once its
 * box is up again, when that box ended or another request is bringing it
 * back; null when there's nothing to do (it is up, or it is another
 * provider's). The claim lets one request restore it; the others wait for it.
 * Throws CloudLimitError when the plan refuses the start.
 */
export async function bringBack(
  provider: ComputerRuntimeProvider,
  workspace: Workspace,
  computer: RuntimeComputer,
  owner: Owner,
): Promise<RuntimeComputer | null> {
  if (computerMadeBy(computer) !== provider.name) return null;
  let ended = endedBoxOf(computer, provider.name);
  if (computer.status === "ready" && computer.daytonaSandboxId) {
    if (await provider.computerAlive(computer.daytonaSandboxId)) return null;
    await markRuntimeComputerStoppedIfReady(computer.id, computer.daytonaSandboxId);
    ended = computer.daytonaSandboxId;
  } else if (!ended && computer.status !== "provisioning") {
    return null;
  }
  const project = await getProject(computer.projectId);
  if (!project) throw new Error(`Project ${computer.projectId} not found`);
  // A box is about to start: the plan's hours and box count get their say,
  // and the claim in the database enforces the cap.
  const scope = scopeOf(workspace, computer);
  const gate = await cloudBoxStartGate(owner, project.orgId, provider.name, scope);
  if ("denial" in gate) throw new CloudLimitError(gate.denial);
  const ensured = await ensureComputer(provider, {
    scope,
    repoFullName: project.fullName,
    // A review box's mirror as the App, as on create: never its user's token.
    githubToken: await optionalGitToken(owner.id, project, await sessionGitAs(workspace.id)),
    sessionEnv: await runtimeSessionEnvironment(owner.id, workspace.id),
    // The owner's size now, as a new box on this provider would get, within
    // their plan on Outrunner's: Modal sizes a box as it starts, restored or not.
    size: boxSizeOn(
      sandboxOf(provider.name),
      newBoxSize(await getSandboxSettings(owner.id), (await orgDefaultsFor(project.orgId)).boxSize),
      await sessionPlan(owner.id, project.orgId),
    ),
    previousSandboxId: ended,
    maxLiveComputers: gate.cap,
  });
  return ensured.computer;
}
