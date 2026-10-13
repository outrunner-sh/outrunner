import {
  cancelClaudeLogin as cancelSetupToken,
  pollClaudeLogin,
  startClaudeLogin,
} from "@/lib/desktop/connect-claude";
import {
  cancelClaudeLogin as cancelClaudeCodeLogin,
  localAgentRequest,
  localStatus,
  localTarget,
  logInToClaude,
  needsClaudeLogin,
  pickLocalFolder,
  putOnOutrunnerModel,
  rememberFolder,
  runsOnOutrunnerModel,
  setsUpClaude,
  setUpClaudeCode,
} from "@/lib/desktop/local-runtime";
import { isDesktopApp } from "@/lib/is-desktop";
import type { FirstSession, OnboardingEnv, OnboardingRepo, OnboardingUser } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long Connect Claude waits for the browser approval. */
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
/** How often to ask whether Claude Code's login has landed. */
const LOGIN_CHECK_MS = 3000;

/**
 * Onboarding on the real thing: the Mac app's bridge for this Mac, and the
 * app's own APIs for the cloud. Each action is the same one the rest of the app
 * uses (Settings → Claude, the new-session form), not a parallel copy.
 */
export function liveEnv(user: OnboardingUser, server: { outrunnerModels: boolean }): OnboardingEnv {
  let loginStopped = false;
  let connectStopped = false;

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

    async connectClaude() {
      connectStopped = false;
      const url = await startClaudeLogin();
      // The shell sends off-site links to the system browser, where Claude's
      // sign-in has to happen.
      window.open(url, "_blank");
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (connectStopped) throw new Error("Cancelled.");
        const poll = await pollClaudeLogin();
        if (poll.state === "ended") throw new Error("That sign-in ended. Start again.");
        if (poll.state === "done") {
          const res = await fetch("/api/settings/claude", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: poll.token }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? "Could not save the connection.");
          }
          return;
        }
      }
      void cancelSetupToken();
      throw new Error("No answer from the browser after five minutes. Start again.");
    },

    cancelConnectClaude() {
      connectStopped = true;
      void cancelSetupToken();
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

    async start(input) {
      const href =
        input.target === "mac" ? await startOnMac(input, server.outrunnerModels) : await startInCloud(input);
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
async function startOnMac({ prompt = "", folder }: FirstSession, outrunnerModels: boolean): Promise<string> {
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
      await putOnOutrunnerModel(workspaceId);
    } catch (error) {
      // Not left to open on Claude Code's login screen.
      void localAgentRequest(target, "POST", `/workspaces/${workspaceId}/destroy`).catch(() => {});
      throw error;
    }
  }
  return `/local/${workspaceId}${promptQuery(prompt)}`;
}

/**
 * Connect the chosen repository, then start the session there, as the
 * new-session form does (its sync and create calls).
 */
async function startInCloud({ prompt = "", repoId }: FirstSession): Promise<string> {
  if (!repoId) throw new Error("Choose a repository first.");
  const synced = await fetch("/api/projects/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoIds: [Number(repoId)] }),
  });
  const syncBody = (await synced.json().catch(() => ({}))) as { projects?: Project[]; error?: string };
  if (!synced.ok) throw new Error(syncBody.error ?? "Could not connect those repositories.");
  const project = syncBody.projects?.find((p) => String(p.githubRepoId) === repoId);
  if (!project) throw new Error("Could not find that repository after connecting it.");

  const created = await fetch(`/api/projects/${project.id}/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch: "" }),
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
    // The session is already started: a missed mark only shows onboarding again.
    console.error("Could not mark onboarding complete", res.status);
  }
}
