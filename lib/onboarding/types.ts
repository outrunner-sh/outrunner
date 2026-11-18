/**
 * What setup needs from the world, behind one seam: the live app's APIs
 * (lib/onboarding/live-env.ts), or mock data for building the screens
 * (components/onboarding/onboarding-preview.tsx).
 *
 * Setup runs per org (lib/orgs/setup.ts): Agent → GitHub → Repositories →
 * Environment, then the new-session screen, on the environment made and the
 * agent picked. The Repositories step is the app's one repository picker
 * (components/repository-picker.tsx), on the live listing.
 */

import type { AgentAuthChoices } from "@/lib/db/credentials";
import type { GitLabConnectionStatus } from "@/lib/gitlab/client";

/** `id` is the account's (Supabase's): what this browser keeps setup's
 *  progress under, with the org's. */
export type OnboardingUser = { id: string; name: string; login: string; avatarUrl: string | null };

/** The org being set up: the active one. Its environment is named after it. */
export type OnboardingOrg = { id: string; name: string; personal: boolean };

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
 *  models, where the server runs them (no account of the user's needed), in
 *  Claude Code ("outrunner") or in Codex ("codex-outrunner"). */
export type AgentPick = "claude" | "codex" | "outrunner" | "codex-outrunner";

/** How a picked agent signs in, in the cloud. */
export type AgentMethod = "subscription" | "api-key";

/** The way the user picked for each agent to sign in (Settings →
 *  Providers); null where they've picked none. */
export type AgentChoices = Pick<AgentAuthChoices, "claude" | "codex">;

export type OnboardingStep = "agent" | "github" | "repos" | "environment";

/** How far the user got, kept in the browser, so setup opens there again
 *  after it's left: for GitHub to install the App, Settings to link GitHub,
 *  or a tab the CLI opened (lib/onboarding/rules.ts resumeAt). */
export type OnboardingProgress = { step: OnboardingStep; done: OnboardingStep[]; runOn: AgentPick };

/** Where the org's repositories come from: the GitHub accounts its Outrunner
 *  GitHub App reaches, installations on GitHub the user could add to it (as
 *  Settings → Org → GitHub offers), or, in a personal org without the App,
 *  the user's own GitHub. */
export type GitHubAccess = {
  /** The user administers the org: installing or adding the App is theirs. */
  admin: boolean;
  /** The accounts the org's App reaches (not suspended). */
  accounts: string[];
  /** Installations on GitHub the user may add to the org. */
  available: { id: number; accountLogin: string }[];
  /** Connected their own GitHub (Settings → Connections): their own
   *  repositories, in their personal org. */
  personalGithub: boolean;
  /** The App is set up on this server, so an admin can install it. */
  appInstallable: boolean;
  /** Installing it needs a GitHub account linked first: GitHub can't be
   *  asked who installed it here (lib/github/installer.ts). */
  installNeedsGithub: boolean;
  /** Their own GitHub can be connected here, through the App's user
   *  authorization (app/api/github/user/connect). */
  personalConnectable: boolean;
};

export type OnboardingEnv = {
  user: OnboardingUser;
  org: OnboardingOrg;
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
  /** How each agent signs in, as picked so far. */
  agentChoices(): Promise<AgentChoices>;
  /** Run sessions of `agent` on `method` from now on (Settings → Providers). */
  chooseMethod(agent: "claude" | "codex", method: AgentMethod): Promise<void>;

  /** Where the org's repositories come from; null before orgs. */
  githubAccess(): Promise<GitHubAccess | null>;
  /** Add an installation on GitHub to the org (Settings → Org → GitHub's
   *  "Add to <org>"). */
  addInstallation(installationId: number): Promise<void>;
  gitlabConnection(): Promise<GitLabConnectionStatus | null>;
  /** Null disconnects; a token connects or replaces the connection. */
  saveGitlabConnection(token: string | null): Promise<GitLabConnectionStatus | null>;

  /** Make the org's first environment, of these connected repositories, its
   *  default; its id. */
  createEnvironment(name: string, projectIds: string[]): Promise<string>;
  /** Finish setup; where the first session is started from: the
   *  new-session screen, on the environment and the agent picked. */
  finish(environmentId: string, runOn: AgentPick): Promise<string>;
  /** Finish setup without a session; where home is. */
  skip(): Promise<string>;

  /** Where the user got to last time, in this browser; null if nowhere. */
  savedProgress(): OnboardingProgress | null;
  saveProgress(progress: OnboardingProgress): void;
};
