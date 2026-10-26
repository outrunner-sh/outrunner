/**
 * What onboarding needs from the world, behind one seam: the live app's APIs
 * (lib/onboarding/live-env.ts), or mock data for building the screens
 * (components/onboarding/onboarding-preview.tsx).
 *
 * The flow is Agent → Repositories → Start, as Replicas' is: the coding agent
 * signed in, the repositories to work on connected, and a first session
 * started on one of them.
 */

import type { RepositoryListing } from "@/lib/github/listing";
import type { Project } from "@/lib/runtime/types";

export type OnboardingUser = { name: string; login: string; avatarUrl: string | null };

/** Whether each agent can run a cloud session on the user's own account. */
export type AgentStatus = {
  claude: {
    /** The Claude subscription token is saved (the "claude-slot"). */
    subscription: boolean;
    /** Its last four characters, to tell which. */
    last4: string | null;
    /** An Anthropic API key is saved. */
    apiKey: boolean;
  };
  codex: { apiKey: boolean };
};

/** The agent a user starts on: their own Claude Code or Codex, or Outrunner's
 *  models, where the server runs them (no account of the user's needed). */
export type AgentPick = "claude" | "codex" | "outrunner";

/** How a picked agent signs in, in the cloud. */
export type AgentMethod = "subscription" | "api-key";

/** The user's GitHub repositories, and which are already projects. */
export type RepositoryList = {
  repositories: RepositoryListing[];
  /** GitHub ids of the repositories already connected as projects. */
  connected: number[];
};

export type OnboardingEnv = {
  user: OnboardingUser;
  /** In the Mac app, Claude's subscription connects with one click there. */
  desktop: boolean;
  /** The server runs Outrunner's models: a session needs no account of the
   *  user's. */
  outrunnerModels: boolean;

  agentStatus(): Promise<AgentStatus>;
  /** Save a Claude subscription token (from `claude setup-token`). */
  saveClaudeToken(token: string): Promise<AgentStatus>;
  /** Save an Anthropic or OpenAI API key. */
  saveApiKey(provider: "anthropic" | "openai", key: string): Promise<AgentStatus>;
  /** Run sessions of `agent` on `method` from now on (Settings → Providers). */
  chooseMethod(agent: "claude" | "codex", method: AgentMethod): Promise<void>;

  repositories(): Promise<RepositoryList>;
  /** Connect repositories as projects; every project the user has after. */
  connect(githubRepoIds: number[]): Promise<Project[]>;

  /** Start a first session on the project, on the agent picked, finishing
   *  onboarding; where it opens. */
  startSession(projectId: string, runOn: AgentPick): Promise<string>;
  /** Finish onboarding without a session; where home is. */
  skip(): Promise<string>;
};
