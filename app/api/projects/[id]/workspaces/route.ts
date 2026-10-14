import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { neevAiKey } from "@/lib/db/credentials";
import {
  createWorkspaceRow,
  getProject,
  getRuntimeComputerByProject,
  markRuntimeComputerStoppedIfReady,
  setWorkspaceTitleIfUnset,
  updateWorkspace,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { keySource } from "@/lib/openrouter/keys";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import {
  HandoffUnavailableError,
  isHandoffId,
  loadHandoff,
  removeHandoff,
} from "@/lib/runtime/handoff/storage";
import { supabaseHandoffStorage } from "@/lib/runtime/storage/supabase-adapter";
import { NoStartingModelError, startingModel } from "@/lib/runtime/model-switch";
import { runtimeSessionEnvironment } from "@/lib/runtime/session-environment";
import { ensureProjectRuntimeComputer } from "@/lib/runtime/runtime-computer-service";
import type { ProvisionPhase } from "@/lib/runtime/types";
import { optionalGithubToken } from "@/lib/github/token";
import { workspaceCloneEnvironment } from "@/lib/runtime/workspace-environment";

export const dynamic = "force-dynamic";

// Lazy provisioning boots a Daytona box + agent (~15s) plus a repo mirror.
// maxDuration caps the per-request wall-clock on serverless hosts (a no-op on a
// long-running server like Railway); 60s covers provisioning with headroom.
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

function isValidBranchName(branch: string): boolean {
  return (
    branch.length >= 1 &&
    branch.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith(".") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock")
  );
}

function generatedBranch(): string {
  return `runtime/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** The project's computer runs an agent from before sessions could be
 *  continued: it made a fresh branch instead of seeding one. */
class AgentTooOldError extends Error {
  constructor() {
    super(
      "This project's cloud computer runs an older Outrunner agent that can't continue a session yet. Start a new cloud session instead, or try again once the computer is updated.",
    );
  }
}

/** The session can't run without the user's Claude: say so, and where to fix it. */
function needsClaude(error: string) {
  return NextResponse.json({ error, settingsHref: "/settings/claude" }, { status: 409 });
}

function safeErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    return "A live workspace already uses that branch for this project.";
  }
  return "Could not create the workspace. Check Outrunner's setup and try again.";
}

/** Create one local worktree from a Runtime project. */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json(
      { error: "Sign in to Outrunner first." },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const githubToken = await optionalGithubToken(owner.id);
  const sessionEnv = await runtimeSessionEnvironment(owner.id);
  // Either credential kind is fine; an empty env means none was set. Sessions
  // start on Outrunner's models, so only without those is Claude a must.
  const hasClaude = Object.keys(sessionEnv).length > 0;
  if (!hasClaude && keySource() === null) {
    return needsClaude("Connect Claude in Settings before creating a workspace.");
  }
  if (project.private && !githubToken) {
    return NextResponse.json(
      {
        error:
          "Connect your GitHub account to clone a private repository: sign out and back in to grant repository access.",
      },
      { status: 409 },
    );
  }

  let body: { branch?: unknown; continueFrom?: { handoffId?: unknown } };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Continuing a session from elsewhere: the package its agent uploaded (only
  // ever the caller's own, by the path loadHandoff builds) seeds this one.
  const handoffId = body.continueFrom?.handoffId;
  if (body.continueFrom !== undefined && !isHandoffId(handoffId)) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const handoffs = isHandoffId(handoffId) ? supabaseHandoffStorage() : null;
  let seed: Awaited<ReturnType<typeof loadHandoff>> | null = null;
  if (handoffs && isHandoffId(handoffId)) {
    try {
      seed = await loadHandoff(handoffs, owner.id, handoffId);
    } catch (error) {
      if (!(error instanceof HandoffUnavailableError)) throw error;
      return NextResponse.json({ error: error.message }, { status: 410 });
    }
  }

  const requestedBranch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (requestedBranch && !isValidBranchName(requestedBranch)) {
    return NextResponse.json(
      { error: "Use a valid Git branch name (letters, numbers, ., _, /, and -)." },
      { status: 400 },
    );
  }

  let provider: ReturnType<typeof getRuntimeProvider>;
  try {
    provider = getRuntimeProvider();
  } catch (error) {
    console.error("Runtime provider is unavailable", error);
    return NextResponse.json(
      { error: "The configured provider is not available." },
      { status: 503 },
    );
  }
  // Only a Runtime Computer's agent can put a session on another model.
  if (!hasClaude && !(provider instanceof DaytonaRuntimeProvider)) {
    return needsClaude("Connect Claude in Settings before creating a workspace.");
  }
  // ...or continue a session from a package.
  if (seed && !(provider instanceof DaytonaRuntimeProvider)) {
    return NextResponse.json(
      { error: "Continuing a session needs Outrunner's cloud computers, which this server doesn't run." },
      { status: 409 },
    );
  }
  // A continued session keeps comparing with what it compared with before.
  const baseBranch = seed?.manifest.baseBranch || project.defaultBranch;

  let workspace;
  try {
    workspace = await createWorkspaceRow({
      ownerId: owner.id,
      projectId: project.id,
      branch: requestedBranch || generatedBranch(),
      baseBranch,
      provider: provider.name,
    });
    if (seed?.manifest.title) {
      // The session's name; it is still the session without it.
      const id = workspace.id;
      await setWorkspaceTitleIfUnset(id, seed.manifest.title).catch((error: unknown) =>
        console.error(`Workspace ${id} title could not be set`, error),
      );
    }
  } catch (error) {
    const message = safeErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: message.startsWith("A live") ? 409 : 500 },
    );
  }

  const setPhase = async (phase: ProvisionPhase) => {
    await updateWorkspace(workspace.id, {
      status: phase === "claude_ready" ? "ready" : "provisioning",
      phase,
      touchActive: phase === "claude_ready",
    });
  };

  try {
    if (provider instanceof DaytonaRuntimeProvider) {
      // A Runtime Computer is intentionally long-lived, but it can still be
      // removed outside Runtime (or become unavailable after a provider
      // incident). Only transition the exact ready row we checked so parallel
      // requests retain the claim RPC's single-provisioner invariant.
      const currentComputer = await getRuntimeComputerByProject(project.id);
      if (
        currentComputer?.status === "ready" &&
        currentComputer.daytonaSandboxId &&
        !(await provider.computerAlive(currentComputer.daytonaSandboxId))
      ) {
        await markRuntimeComputerStoppedIfReady(
          currentComputer.id,
          currentComputer.daytonaSandboxId,
        );
      }

      const ensured = await ensureProjectRuntimeComputer(provider, {
        projectId: project.id,
        repoFullName: project.fullName,
        githubToken,
        sessionEnv,
      });
      const computer = ensured.computer;
      if (!computer.daytonaSandboxId) {
        throw new Error("Ready Runtime Computer has no Daytona sandbox id.");
      }

      // Initial provisioning clones the mirror. Every later workspace refreshes
      // it before the agent branches from the project's default branch.
      if (!ensured.provisioned) {
        await provider.fetchMirror(computer.daytonaSandboxId, githubToken);
      }

      const target = await provider.agentTarget(
        computer.daytonaSandboxId,
        ensured.agentSecret,
      );
      const identity: WorkspaceIdentity = {
        workspaceId: workspace.id,
        projectId: project.id,
        computerId: computer.id,
        userId: owner.id,
      };
      const agent = new AgentClient(target);
      const created = await agent.createWorkspace(
        {
          workspaceId: workspace.id,
          repoFullName: project.fullName,
          baseBranch,
          branch: workspace.branch,
          ...(seed ? { from: seed } : {}),
        },
        identity,
      );
      if (seed && !created.seeded) {
        await agent.destroyWorkspace(identity).catch(() => {});
        throw new AgentTooOldError();
      }
      // Before the first launch, so Claude starts on it rather than switching.
      await startingModel({
        setModel: (req) => agent.setModel(identity, req),
        neevKey: () => neevAiKey(owner.id),
        hasClaude,
      });
      await agent.startWorkspace(identity);

      await updateWorkspace(workspace.id, {
        status: "ready",
        phase: "claude_ready",
        computerId: computer.id,
        tmuxSession: `ws-${workspace.id}`,
        agentWorkspaceId: workspace.id,
        worktreePath: created.worktree,
        errorMessage: null,
        touchActive: true,
      });
      return NextResponse.json({ workspace: { id: workspace.id } }, { status: 201 });
    }

    const result = await provider.createWorkspace({
      workspaceId: workspace.id,
      repoFullName: project.fullName,
      baseBranch: project.defaultBranch,
      branch: workspace.branch,
      env: workspaceCloneEnvironment(githubToken),
      onPhase: setPhase,
    });

    await updateWorkspace(workspace.id, {
      status: "ready",
      phase: "claude_ready",
      sandboxId: result.sandboxId,
      volumeName: result.volumeName,
      worktreePath: result.worktreePath,
      errorMessage: result.warnings.length
        ? "Dependency installation completed with warnings."
        : null,
      touchActive: true,
    });
    return NextResponse.json({ workspace: { id: workspace.id } }, { status: 201 });
  } catch (error) {
    console.error(`Workspace ${workspace.id} provisioning failed`, error);
    const noModel = error instanceof NoStartingModelError;
    const tooOld = error instanceof AgentTooOldError;
    try {
      await updateWorkspace(workspace.id, {
        status: "failed",
        errorMessage: noModel || tooOld ? error.message : "Provisioning failed. Check Outrunner's setup and try again.",
      });
    } catch (updateError) {
      console.error(`Workspace ${workspace.id} failure state could not be saved`, updateError);
    }
    if (noModel) return needsClaude(error.message);
    if (tooOld) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json(
      { error: "Could not create the workspace. Check Outrunner's setup and try again." },
      { status: 500 },
    );
  } finally {
    // Used or not, a package is made once: a retry packs the session again.
    if (handoffs && isHandoffId(handoffId)) {
      await removeHandoff(handoffs, owner.id, handoffId).catch((error: unknown) =>
        console.error(`Handoff ${handoffId} could not be removed`, error),
      );
    }
  }
}
