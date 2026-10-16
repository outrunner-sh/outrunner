import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  getSandboxSettings,
  neevAiKey,
  ownSandboxKeys,
  type SandboxSettings,
} from "@/lib/db/credentials";
import {
  createWorkspaceRow,
  getProject,
  getRuntimeComputerByProject,
  markRuntimeComputerStoppedIfReady,
  updateWorkspace,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { keySource } from "@/lib/openrouter/keys";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { NoDaytonaKeyError } from "@/lib/runtime/daytona-provider";
import { NoStartingModelError, startingModel } from "@/lib/runtime/model-switch";
import {
  computerMadeBy,
  endedBoxOf,
  newBoxSize,
  providerForNewSessions,
  retireComputer,
} from "@/lib/runtime/sandbox-choice";
import { NoModalTokenError } from "@/lib/runtime/user-modal-provider";
import { runtimeSessionEnvironment } from "@/lib/runtime/session-environment";
import { ensureProjectRuntimeComputer } from "@/lib/runtime/runtime-computer-service";
import type { ProvisionPhase, RuntimeProvider } from "@/lib/runtime/types";
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

/** The session can't run without the user's Claude: say so, and where to fix it. */
function needsClaude(error: string) {
  return NextResponse.json({ error, settingsHref: "/settings/claude" }, { status: 409 });
}

function needsSandbox(error: string) {
  return NextResponse.json({ error, settingsHref: "/settings/sandbox" }, { status: 409 });
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

  let body: { branch?: unknown };
  try {
    body = (await request.json()) as { branch?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const requestedBranch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (requestedBranch && !isValidBranchName(requestedBranch)) {
    return NextResponse.json(
      { error: "Use a valid Git branch name (letters, numbers, ., _, /, and -)." },
      { status: 400 },
    );
  }

  const keys = ownSandboxKeys(owner.id);
  let sandboxSettings: SandboxSettings;
  let provider: RuntimeProvider;
  try {
    // Outrunner's sandboxes, or the user's own Daytona or Modal (Settings → Sandbox).
    sandboxSettings = await getSandboxSettings(owner.id);
    provider = providerForNewSessions(sandboxSettings, keys);
  } catch (error) {
    if (error instanceof NoDaytonaKeyError || error instanceof NoModalTokenError) return needsSandbox(error.message);
    console.error("Runtime provider is unavailable", error);
    return NextResponse.json(
      { error: "The configured provider is not available." },
      { status: 503 },
    );
  }
  // Only a Runtime Computer's agent can put a session on another model.
  if (!hasClaude && !isComputerProvider(provider)) {
    return needsClaude("Connect Claude in Settings before creating a workspace.");
  }

  let workspace;
  try {
    workspace = await createWorkspaceRow({
      ownerId: owner.id,
      projectId: project.id,
      branch: requestedBranch || generatedBranch(),
      baseBranch: project.defaultBranch,
      provider: provider.name,
    });
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
    if (isComputerProvider(provider)) {
      // A Runtime Computer is intentionally long-lived, but it can still be
      // removed outside Runtime (or become unavailable after a provider
      // incident). Only transition the exact ready row we checked so parallel
      // requests retain the claim RPC's single-provisioner invariant.
      const currentComputer = await getRuntimeComputerByProject(project.id);
      // The box that ended, for a provider that brings it back on the disk it
      // left (Modal), so the project's sessions carry on in the new one.
      let endedBox = endedBoxOf(currentComputer, provider.name);
      if (currentComputer?.status === "ready" && currentComputer.daytonaSandboxId) {
        const sandboxId = currentComputer.daytonaSandboxId;
        const madeBy = computerMadeBy(currentComputer);
        if (madeBy !== provider.name) {
          // The owner moved to another sandbox (Settings → Sandbox). The old
          // box goes, so no one keeps paying for one nothing uses, and the
          // project gets a new computer where they chose.
          await retireComputer(madeBy, keys, sandboxId);
          await markRuntimeComputerStoppedIfReady(currentComputer.id, sandboxId);
        } else if (!(await provider.computerAlive(sandboxId))) {
          await markRuntimeComputerStoppedIfReady(currentComputer.id, sandboxId);
          endedBox = sandboxId;
        }
      }

      const ensured = await ensureProjectRuntimeComputer(provider, {
        projectId: project.id,
        repoFullName: project.fullName,
        githubToken,
        sessionEnv,
        size: newBoxSize(sandboxSettings),
        ...(provider.restoresBoxes && endedBox && { previousSandboxId: endedBox }),
      });
      const computer = ensured.computer;
      if (!computer.daytonaSandboxId) {
        throw new Error("Ready Runtime Computer has no sandbox id.");
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
          baseBranch: project.defaultBranch,
          branch: workspace.branch,
        },
        identity,
      );
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
    try {
      await updateWorkspace(workspace.id, {
        status: "failed",
        errorMessage: noModel ? error.message : "Provisioning failed. Check Outrunner's setup and try again.",
      });
    } catch (updateError) {
      console.error(`Workspace ${workspace.id} failure state could not be saved`, updateError);
    }
    if (noModel) return needsClaude(error.message);
    return NextResponse.json(
      { error: "Could not create the workspace. Check Outrunner's setup and try again." },
      { status: 500 },
    );
  }
}
