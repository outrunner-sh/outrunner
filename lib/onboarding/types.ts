/**
 * What the onboarding flow needs from the world, as one adapter.
 *
 * The flow is UI only: every check and action goes through this, so the same
 * screens run on mock data (the preview, while the design settles) and later on
 * the real desktop bridge and APIs.
 */

/** Where the user's sessions run. */
export type RunTarget = "mac" | "cloud";

/** What this Mac has for local sessions. */
export type MacStatus = {
  /** The agent bundled with the app; missing only in a broken install. */
  agent: boolean;
  git: boolean;
  tmux: boolean;
  claude: boolean;
  /** Whether Claude Code is logged in; null when it could not tell. */
  claudeLoggedIn: boolean | null;
};

export type OnboardingFolder = {
  path: string;
  name: string;
  /** A git repository: each session gets its own worktree off `branch`. */
  git: boolean;
  branch: string | null;
};

export type OnboardingRepo = {
  id: string;
  fullName: string;
  private: boolean;
  /** When it was last pushed to, for ordering and a hint. */
  pushedAt: string;
};

export type OnboardingUser = {
  name: string;
  login: string;
  avatarUrl: string | null;
};

export type OnboardingEnv = {
  user: OnboardingUser;
  /** Inside the Outrunner Mac app, where This Mac and Connect Claude work. */
  desktop: boolean;
  /** Whether a cloud session may start on Neev AI models without Claude. */
  neevForCloud: boolean;
  checkMac(): Promise<MacStatus>;
  /** Run `claude auth login`; resolves once the user approved in the browser. */
  logInToClaudeCode(): Promise<void>;
  cancelClaudeCodeLogin(): void;
  /** The folder dialog; null when cancelled. */
  pickFolder(): Promise<OnboardingFolder | null>;
  /** Whether a Claude credential is already stored for cloud sessions. */
  claudeConnected(): Promise<boolean>;
  /** Connect Claude (`claude setup-token`); resolves once the token is saved. */
  connectClaude(): Promise<void>;
  cancelConnectClaude(): void;
  listRepos(): Promise<OnboardingRepo[]>;
  /** Start the first session; resolves with where to go next, or null to stay. */
  start(input: FirstSession): Promise<string | null>;
  /** Leave onboarding without a session; absent where there is nothing to skip to. */
  skip?(): Promise<string>;
};

export type FirstSession = {
  target: RunTarget;
  /** A first message to send; onboarding opens the session without one. */
  prompt?: string;
  /** This Mac: the folder chosen. */
  folder?: OnboardingFolder;
  /** Cloud: the repositories chosen; the session runs on the first. */
  repoIds?: string[];
  /** Cloud: the user's own Claude, or Neev AI models. */
  model?: "claude" | "neev";
};
