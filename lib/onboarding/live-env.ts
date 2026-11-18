import { forgetOutrunnerModels } from "@/lib/desktop/local-runtime";
import { isDesktopApp } from "@/lib/is-desktop";
import { newSessionAfterOnboarding, parseProgress } from "@/lib/onboarding/rules";
import type {
  AgentChoices,
  AgentStatus,
  GitHubAccess,
  OnboardingEnv,
  OnboardingOrg,
  OnboardingProgress,
  OnboardingUser,
} from "@/lib/onboarding/types";
import type { GitLabConnectionStatus } from "@/lib/gitlab/client";

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
async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
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

/** Mark the org's setup done, so home stops sending anyone here. A failure
 *  is logged only: setup just shows again. */
async function markSetUp(): Promise<void> {
  try {
    await call("POST", "/api/onboarding/complete");
  } catch (error) {
    console.error("Could not mark setup done", error);
  }
}

/** Where this browser keeps the user's progress setting up an org:
 *  localStorage, so a tab the CLI opens finds it too. Storage that fails
 *  (private mode, full) only means setup opens at its start. */
function progressStore(userId: string, orgId: string) {
  const key = `outrunner:onboarding:${userId}:${orgId}`;
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
 * Setup on the live app: the same APIs Settings → Providers, Settings → Org
 * → GitHub, the repository picker and Environments use, not copies of them.
 */
export function liveEnv(user: OnboardingUser, org: OnboardingOrg, server: { outrunnerModels: boolean }): OnboardingEnv {
  const progress = progressStore(user.id, org.id);
  const agentStatus = async (): Promise<AgentStatus> => {
    const [claude, providers] = await Promise.all([
      call<{ connected: boolean; last4: string | null }>("GET", "/api/settings/claude"),
      call<{ keys: Record<string, { connected: boolean }> }>("GET", "/api/settings/providers"),
    ]);
    return {
      claude: { subscription: claude.connected, last4: claude.last4, apiKey: Boolean(providers.keys.anthropic?.connected) },
      codex: { apiKey: Boolean(providers.keys.openai?.connected) },
    };
  };

  return {
    user,
    org,
    desktop: isDesktopApp(),
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
      forgetOutrunnerModels();
    },

    githubAccess: () => call<{ access: GitHubAccess | null }>("GET", "/api/onboarding/github").then((r) => r.access),
    addInstallation: (installationId) =>
      call("POST", `/api/orgs/${org.id}/github/installations`, { installationId }).then(() => undefined),
    gitlabConnection: () => call<{ connection: GitLabConnectionStatus | null }>("GET", "/api/gitlab/connection").then((r) => r.connection),
    saveGitlabConnection: (token) => call<{ connection: GitLabConnectionStatus | null }>(token === null ? "DELETE" : "POST", "/api/gitlab/connection", token === null ? undefined : { token }).then((r) => r.connection),

    async createEnvironment(name, projectIds) {
      const made = await call<{ id: string }>("POST", "/api/environments", { name, projectIds, orgDefault: true });
      return made.id;
    },
    async finish(environmentId, runOn) {
      await markSetUp();
      progress.write(null);
      return newSessionAfterOnboarding(environmentId, runOn);
    },
    async skip() {
      await markSetUp();
      progress.write(null);
      return "/";
    },

    savedProgress: () => progress.read(),
    saveProgress: (next) => progress.write(next),
  };
}
