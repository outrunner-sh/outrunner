import {
  cancelClaudeLogin as cancelClaudeCodeLogin,
  importScan,
  localAgentRequest,
  localStatus,
  localTarget,
  logInToClaude,
  needsClaudeLogin,
  pickLocalFolder,
  putOnDefaultModel,
  rememberFolder,
  runsOnOutrunnerModel,
  setsUpClaude,
  setUpClaudeCode,
} from "@/lib/desktop/local-runtime";
import { isDesktopApp } from "@/lib/is-desktop";
import { importFound } from "@/lib/onboarding/import-offer";
import type {
  CloudSession,
  OnboardingEnv,
  OnboardingFinish,
  OnboardingRepo,
  OnboardingUser,
} from "@/lib/onboarding/types";
import { CLAUDE_MODELS } from "@/lib/runtime/session-models";
import type { Project } from "@/lib/runtime/types";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How often to ask whether Claude Code's login has landed. */
const LOGIN_CHECK_MS = 3000;

/**
 * Onboarding on the real thing: the Mac app's bridge for this Mac, and the
 * app's own APIs for the cloud. Each action is the same one the rest of the app
 * uses (the new-session form, Settings → Providers), not a parallel copy.
 */
export function liveEnv(user: OnboardingUser, server: { outrunnerModels: boolean }): OnboardingEnv {
  let loginStopped = false;

  return {
    user,
    desktop: isDesktopApp(),
    // Whether a cloud session may start without the user's Claude, on
    // Outrunner's models: the server knows, from its OpenRouter key.
    outrunnerModels: server.outrunnerModels,

    async checkMac() {
      const status = await localStatus();
      if (!status) throw new Error("Sessions on this Mac run in the Outrunner Mac app.");
      return {
        agent: status.agentBundled,
        git: Boolean(status.git),
        tmux: Boolean(status.tmux),
        claude: Boolean(status.claude),
        claudeLoggedIn: status.claudeLoggedIn ?? null,
        setsUpClaude: setsUpClaude(status),
        claudeSetup: status.claudeSetup ?? null,
      };
    },

    setUpClaudeCode,

    async logInToClaudeCode() {
      loginStopped = false;
      // The CLI normally exits once logged in; the status check covers one that
      // logs in and stays up, as on the new-session form.
      const landed = (async () => {
        while (!loginStopped) {
          await wait(LOGIN_CHECK_MS);
          const status = await localStatus().catch(() => null);
          if (status && !needsClaudeLogin(status)) return;
        }
        return new Promise<void>(() => {}); // stopped: let the CLI's answer decide
      })();
      try {
        await Promise.race([logInToClaude(), landed]);
      } finally {
        loginStopped = true;
        void cancelClaudeCodeLogin().catch(() => {});
      }
    },

    cancelClaudeCodeLogin() {
      loginStopped = true;
      void cancelClaudeCodeLogin().catch(() => {});
    },

    async pickFolder() {
      const folder = await pickLocalFolder();
      if (!folder) return null;
      // The new-session form starts in the same folder next time.
      rememberFolder(folder.path);
      return { path: folder.path, name: folder.name, git: folder.git, branch: folder.branch };
    },

    async claudeConnected() {
      const res = await fetch("/api/settings/claude").catch(() => null);
      if (!res?.ok) return false;
      return Boolean(((await res.json()) as { connected?: boolean }).connected);
    },

    async listRepos() {
      const res = await fetch("/api/github/repositories");
      const data = (await res.json().catch(() => ({}))) as {
        repositories?: { githubRepoId: number; fullName: string; private: boolean; pushedAt: string | null }[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Could not load your GitHub repositories.");
      return (data.repositories ?? [])
        .map(
          (r): OnboardingRepo => ({
            id: String(r.githubRepoId),
            fullName: r.fullName,
            private: r.private,
            pushedAt: r.pushedAt ?? "",
          }),
        )
        .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
    },

    async findImports() {
      // A scan that fails only means nothing is offered: /import scans again.
      return importFound(await importScan().catch(() => null));
    },

    async finish(input) {
      const href =
        input.target === "mac" ? await startOnMac(input, server.outrunnerModels) : await finishInCloud(input);
      await markOnboarded();
      return href;
    },

    async skip() {
      await markOnboarded();
      return "/";
    },
  };
}

/**
 * Same as the new-session form's local start (use-create-session.ts): on a Mac
 * whose Claude Code isn't logged in, where the server runs Outrunner's models,
 * the session starts on those.
 */
async function startOnMac(
  { prompt = "", folder }: Extract<OnboardingFinish, { target: "mac" }>,
  outrunnerModels: boolean,
): Promise<string> {
  if (!folder) throw new Error("Choose a folder first.");
  const workspaceId = crypto.randomUUID();
  const target = localTarget(workspaceId);
  await localAgentRequest(target, "POST", "/workspaces", {
    workspaceId,
    repoFullName: folder.name,
    branch: `runtime/${Date.now().toString(36)}-${workspaceId.slice(0, 8)}`,
    repoPath: folder.path,
    // The first prompt names the session; without one the folder does.
    ...(prompt ? { title: Array.from(prompt).slice(0, 120).join("") } : {}),
  });
  const status = outrunnerModels ? await localStatus().catch(() => null) : null;
  if (status && runsOnOutrunnerModel(status, outrunnerModels)) {
    try {
      await putOnDefaultModel(workspaceId);
    } catch (error) {
      // Not left to open on Claude Code's login screen.
      void localAgentRequest(target, "POST", `/workspaces/${workspaceId}/destroy`).catch(() => {});
      throw error;
    }
  }
  return `/local/${workspaceId}${promptQuery(prompt)}`;
}

/**
 * Connect the chosen repositories, as the repository picker does, then go
 * where the user chose: a first session in one of them, as the new-session
 * form starts one, on the model chosen; the import; or home.
 */
async function finishInCloud({
  repoIds,
  session,
  next = "home",
}: Extract<OnboardingFinish, { target: "cloud" }>): Promise<string> {
  if (session && !repoIds.includes(session.repoId)) throw new Error("Choose that repository first.");
  const projects = repoIds.length > 0 ? await connectRepos(repoIds) : [];
  if (!session) return next === "import" ? "/import" : "/";
  const project = projects.find((p) => String(p.githubRepoId) === session.repoId);
  if (!project) throw new Error("Could not find that repository after connecting it.");
  return startInCloud(project, session);
}

async function connectRepos(repoIds: string[]): Promise<Project[]> {
  const synced = await fetch("/api/projects/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoIds: repoIds.map(Number) }),
  });
  const body = (await synced.json().catch(() => ({}))) as { projects?: Project[]; error?: string };
  if (!synced.ok) throw new Error(body.error ?? "Could not connect those repositories.");
  return body.projects ?? [];
}

async function startInCloud(project: Project, { prompt = "", model }: CloudSession): Promise<string> {
  const created = await fetch(`/api/projects/${project.id}/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Claude, when the user has it: the first of its models. Otherwise none,
    // so the session starts on the menu's default, Outrunner's.
    body: JSON.stringify({
      branch: "",
      ...(model === "claude" && { provider: "claude", model: CLAUDE_MODELS[0].id }),
    }),
  });
  const result = (await created.json().catch(() => ({}))) as { workspace?: { id: string }; error?: string };
  if (!created.ok || !result.workspace) {
    throw new Error(result.error ?? "Could not start the session. Please try again.");
  }
  return `/workspaces/${result.workspace.id}${promptQuery(prompt)}`;
}

/** The session page sends `?prompt=` as the first message; none, no query. */
function promptQuery(prompt: string): string {
  return prompt ? `?${new URLSearchParams({ prompt })}` : "";
}

async function markOnboarded(): Promise<void> {
  const res = await fetch("/api/onboarding/complete", { method: "POST" });
  if (!res.ok) {
    // The user is already on their way: a missed mark only shows onboarding again.
    console.error("Could not mark onboarding complete", res.status);
  }
}
