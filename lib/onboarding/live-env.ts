import { forgetOutrunnerModels, localStatus, tauriCore, logInToClaude, logInToCodex, cancelClaudeLogin, cancelCodexLogin, pickLocalFolder } from "@/lib/desktop/local-runtime";
import { AGENT_AUTH_CHOICES } from "@/lib/client/agent-auth-choices";
import type { AuthMethodId } from "@/lib/agents/registry";
import { isDesktopApp } from "@/lib/is-desktop";
import { newSessionAfterOnboarding, parseProgress } from "@/lib/onboarding/rules";
import type {
  AgentChoices,
  AgentStatus,
  GitHubAccess,
  OnboardingEnv,
  OnboardingProgress,
  OnboardingUser,
  RepositoryList,
} from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";

/** A failure the page can show, with where to fix it when there's a place. */
export class OnboardingError extends Error {
  readonly href?: string;
  /** GitHub refused the stored token: only signing in again fixes it. */
  readonly reconnect: boolean;
  constructor(message: string, href?: string, reconnect = false) {
    super(message);
    this.name = "OnboardingError";
    this.href = href;
    this.reconnect = reconnect;
  }
}

/** A JSON request to the app's own API; its `error` (and `settingsHref`)
 *  thrown as an OnboardingError when it fails. */
async function call<T>(method: "GET" | "POST" | "PUT", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    ...(body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as
    | (T & { error?: string; settingsHref?: string; reconnect?: boolean })
    | null;
  if (!res.ok) {
    throw new OnboardingError(json?.error ?? "Something went wrong. Please try again.", json?.settingsHref, json?.reconnect === true);
  }
  return json as T;
}

/** Mark onboarding done, so home stops sending the user here. A failure is
 *  logged only: onboarding just shows again. */
async function markOnboarded(): Promise<void> {
  try {
    await call("POST", "/api/onboarding/complete");
  } catch (error) {
    console.error("Could not mark onboarding done", error);
  }
}

/** Where this browser keeps the user's onboarding progress: localStorage,
 *  so a tab the CLI opens finds it too. Storage that fails (private mode,
 *  full) only means onboarding opens at its start. */
function progressStore(userId: string) {
  const key = `outrunner:onboarding:${userId}`;
  return {
    read(): OnboardingProgress | null {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? parseProgress(JSON.parse(raw)) : null;
      } catch {
        return null;
      }
    },
    write(progress: OnboardingProgress | null) {
      try {
        if (progress) window.localStorage.setItem(key, JSON.stringify(progress));
        else window.localStorage.removeItem(key);
      } catch {
        // Kept only for next time; nothing to tell.
      }
    },
  };
}

/**
 * Onboarding on the live app: the same APIs Settings → Providers, the
 * repository picker and the new-session form use, not copies of them.
 */
export function liveEnv(user: OnboardingUser, server: { outrunnerModels: boolean }): OnboardingEnv {
  const progress = progressStore(user.id);
  const desktop = isDesktopApp();
  const agentStatus = async (): Promise<AgentStatus> => {
    const [claude, providers, effective, local] = await Promise.all([
      call<{ connected: boolean; last4: string | null }>("GET", "/api/settings/claude").catch((error) => { if (!desktop) throw error; return { connected: false, last4: null }; }),
      call<{ keys: Record<string, { connected: boolean }> }>("GET", "/api/settings/providers").catch((error) => { if (!desktop) throw error; return { keys: {} as Record<string, { connected: boolean }> }; }),
      call<{ methods: Record<"claude" | "codex", AuthMethodId[]> }>("GET", "/api/onboarding/agents").catch(() => null),
      desktop ? localStatus().then((status) => ({ status, error: undefined as string | undefined }), (e: unknown) => ({ status: null, error: e instanceof Error ? e.message : "Couldn’t check the agents on this Mac. Try again." })) : null,
    ]);
    return {
      claude: { subscription: claude.connected, last4: claude.last4, apiKey: Boolean(providers.keys.anthropic?.connected) },
      codex: { apiKey: Boolean(providers.keys.openai?.connected), ...(effective && { account: effective.methods.codex.includes("codex-account") }) },
      ...(effective && { cloud: effective.methods }),
      ...(local && { local: local.status, ...(local.error && { localError: local.error }) }),
    };
  };

  return {
    user,
    desktop,
    async setupAgent(agent) {
      const core = tauriCore();
      if (!core) throw new Error("Update the Outrunner desktop app to prepare coding agents automatically.");
      try { await core.invoke("local_agent_setup", { agent }); }
      catch (e) { throw new Error(typeof e === "string" && /not found|not allowed/i.test(e) ? "Update the Outrunner desktop app to prepare coding agents automatically." : String(e)); }
    },
    loginAgent: (agent) => agent === "claude" ? logInToClaude() : logInToCodex(),
    cancelLogin: (agent) => agent === "claude" ? cancelClaudeLogin() : cancelCodexLogin(),
    pickFolder: pickLocalFolder,
    outrunnerModels: server.outrunnerModels,
    agentStatus,

    async saveClaudeToken(token) {
      await call("PUT", "/api/settings/claude", { token });
      forgetOutrunnerModels();
      return agentStatus();
    },
    async saveApiKey(provider, key) {
      await call("PUT", "/api/settings/providers", { provider, key });
      forgetOutrunnerModels();
      return agentStatus();
    },
    async agentChoices() {
      const { choices } = await call<{ choices: Partial<AgentChoices> }>("GET", "/api/settings/agents");
      return { claude: choices.claude ?? null, codex: choices.codex ?? null };
    },
    async chooseMethod(agent, method) {
      await call("PUT", "/api/settings/agents", { agent, method });
      AGENT_AUTH_CHOICES.invalidate();
      forgetOutrunnerModels();
    },

    githubAccess: () => call<{ access: GitHubAccess | null }>("GET", "/api/onboarding/github").then((r) => r.access),
    useOrg: (orgId) => call("POST", "/api/orgs/active", { orgId }).then(() => undefined),
    repositories: () => call<RepositoryList>("GET", "/api/github/repositories"),
    async connect(githubRepoIds) {
      const { projects } = await call<{ projects: Project[] }>("POST", "/api/projects/sync", { repoIds: githubRepoIds });
      return projects;
    },

    async finish(projectId, runOn, target, folder) {
      await markOnboarded();
      progress.write(null);
      return newSessionAfterOnboarding(projectId, runOn, target, folder);
    },
    async skip() {
      await markOnboarded();
      progress.write(null);
      return "/";
    },

    savedProgress: () => progress.read(),
    saveProgress: (next) => progress.write(next),
  };
}
