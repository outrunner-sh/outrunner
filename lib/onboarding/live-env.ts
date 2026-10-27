import type { AgentId } from "@/lib/agents/registry";
import { forgetOutrunnerModels } from "@/lib/desktop/local-runtime";
import { isDesktopApp } from "@/lib/is-desktop";
import type { AgentPick, AgentStatus, OnboardingEnv, OnboardingUser, RepositoryList } from "@/lib/onboarding/types";
import {
  CLAUDE_DEFAULT_MODEL,
  CODEX_MODELS,
  DEFAULT_EFFORT,
  type Effort,
  OUTRUNNER_MODELS,
} from "@/lib/runtime/session-models";
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

/** The model a first session starts on, by the agent picked: the user's own
 *  Claude or Codex, at DEFAULT_EFFORT, as the new-session screen starts them;
 *  or Outrunner's first model, in Codex where that is the pick (Claude Code
 *  would be its default). Always named: with no model, a user whose Claude is
 *  connected would start on it, not on the Outrunner's models they picked. */
export function firstModel(runOn: AgentPick): { provider: string; model: string; effort?: Effort; agent?: AgentId } {
  if (runOn === "claude") return { provider: "claude", model: CLAUDE_DEFAULT_MODEL.id, effort: DEFAULT_EFFORT };
  if (runOn === "codex") return { provider: "codex", model: CODEX_MODELS[0].id, effort: DEFAULT_EFFORT };
  const outrunner = { provider: "outrunner", model: OUTRUNNER_MODELS[0].id };
  return runOn === "codex-outrunner" ? { ...outrunner, agent: "codex" } : outrunner;
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

/**
 * Onboarding on the live app: the same APIs Settings → Providers, the
 * repository picker and the new-session form use, not copies of them.
 */
export function liveEnv(user: OnboardingUser, server: { outrunnerModels: boolean }): OnboardingEnv {
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
    async chooseMethod(agent, method) {
      await call("PUT", "/api/settings/agents", { agent, method });
      forgetOutrunnerModels();
    },

    repositories: () => call<RepositoryList>("GET", "/api/github/repositories"),
    async connect(githubRepoIds) {
      const { projects } = await call<{ projects: Project[] }>("POST", "/api/projects/sync", { repoIds: githubRepoIds });
      return projects;
    },

    async startSession(projectId, runOn) {
      const { workspace } = await call<{ workspace?: { id: string } }>("POST", `/api/projects/${projectId}/workspaces`, {
        branch: "",
        ...firstModel(runOn),
      });
      if (!workspace) throw new OnboardingError("The session didn't start. Please try again.");
      await markOnboarded();
      return `/workspaces/${workspace.id}`;
    },
    async skip() {
      await markOnboarded();
      return "/";
    },
  };
}
