/**
 * What onboarding needs from the world, behind one seam: the live app's APIs
 * (lib/onboarding/live-env.ts), or mock data for building the screens
 * (components/onboarding/onboarding-preview.tsx).
 *
 * The flow is Agent → Repositories: the coding agent signed in and the
 * repositories to work on connected, then the new-session screen, on the
 * first of them and the agent picked.
 */

import type { AgentAuthChoices } from "@/lib/db/credentials";
import type { RepositoryListing } from "@/lib/github/listing";
import type { Project } from "@/lib/runtime/types";

/** `id` is the account's (Supabase's): what this browser keeps onboarding's
 *  progress under. */
export type OnboardingUser = { id: string; name: string; login: string; avatarUrl: string | null };

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

export type OnboardingStep = "agent" | "repos";

/** How far the user got, kept in the browser, so onboarding opens there
 *  again after it's left: for GitHub to install the App, Settings to link
 *  GitHub, or a tab the CLI opened (lib/onboarding/rules.ts resumeAt). */
export type OnboardingProgress = { step: OnboardingStep; done: OnboardingStep[]; runOn: AgentPick };

/** The user's GitHub repositories, and which are already projects. */
export type RepositoryList = {
  repositories: RepositoryListing[];
  /** GitHub ids of the repositories already connected as projects. */
  connected: number[];
};

/** Where the repositories come from: the org they're added to (the active
 *  one) and the user's others, each with the GitHub accounts its Outrunner
 *  GitHub App reaches. An org without the App lists the user's own, when
 *  they signed in with GitHub. */
export type GitHubAccess = {
  orgs: { id: string; name: string; personal: boolean; admin: boolean; accounts: string[] }[];
  activeOrgId: string;
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

  /** Where repositories come from; null before orgs. */
  githubAccess(): Promise<GitHubAccess | null>;
  /** Add repositories to this org from now on (the active org). */
  useOrg(orgId: string): Promise<void>;
  repositories(): Promise<RepositoryList>;
  /** Connect repositories as projects; every project the user has after. */
  connect(githubRepoIds: number[]): Promise<Project[]>;

  /** Finish onboarding; where the first session is started from: the
   *  new-session screen, on the project and the agent picked. */
  finish(projectId: string | undefined, runOn: AgentPick): Promise<string>;
  /** Finish onboarding without a session; where home is. */
  skip(): Promise<string>;

  /** Where the user got to last time, in this browser; null if nowhere. */
  savedProgress(): OnboardingProgress | null;
  saveProgress(progress: OnboardingProgress): void;
};
