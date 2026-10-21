/**
 * What the onboarding flow needs from the world, as one adapter.
 *
 * The flow is UI only: every check and action goes through this, so the same
 * screens run on mock data (the preview, while the design settles) and later on
 * the real desktop bridge and APIs.
 */

import type { ClaudeSetup } from "@/lib/desktop/local-runtime";
import type { ImportFound } from "@/lib/onboarding/import-offer";

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
  /** The app sets up its own Claude Code when there is none that runs, so
   *  the user installs nothing. False in an app built before it could. */
  setsUpClaude: boolean;
  /** Where that setup has got to; null when nothing is under way. */
  claudeSetup: ClaudeSetup | null;
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
  /** Whether a cloud session may start on Outrunner's models without Claude. */
  outrunnerModels: boolean;
  checkMac(): Promise<MacStatus>;
  /** Start setting up the app's own Claude Code; `checkMac` follows it. */
  setUpClaudeCode(): Promise<void>;
  /** Run `claude auth login`; resolves once the user approved in the browser. */
  logInToClaudeCode(): Promise<void>;
  cancelClaudeCodeLogin(): void;
  /** The folder dialog; null when cancelled. */
  pickFolder(): Promise<OnboardingFolder | null>;
  /** Whether a Claude credential is already stored for cloud sessions. */
  claudeConnected(): Promise<boolean>;
  /** Whether Claude Code is logged in on this Mac, a sign the user has Claude
   *  to connect; false outside the Mac app, or when it can't tell. */
  claudeOnMac(): Promise<boolean>;
  /** Connect Claude (`claude setup-token`); resolves once the token is saved. */
  connectClaude(): Promise<void>;
  cancelConnectClaude(): void;
  listRepos(): Promise<OnboardingRepo[]>;
  /** What the Mac app's scan found to bring over from this Mac; null outside
   *  the app, with nothing to import, or when the scan fails. */
  findImports(): Promise<ImportFound | null>;
  /** Finish onboarding; resolves with where to go next, or null to stay. */
  finish(input: OnboardingFinish): Promise<string | null>;
  /** Leave onboarding without a session; absent where there is nothing to skip to. */
  skip?(): Promise<string>;
};

/**
 * How onboarding ends. On this Mac, in the first session there. In the cloud,
 * with the chosen repositories connected and then, as the user picked, a
 * first session in one of them, the import of this Mac's work, or home.
 */
export type OnboardingFinish =
  | {
      target: "mac";
      folder?: OnboardingFolder;
      /** A first message to send; onboarding opens the session without one. */
      prompt?: string;
    }
  | {
      target: "cloud";
      /** The repositories to connect, by GitHub id; none is fine. */
      repoIds: string[];
      /** A first session, in one of `repoIds`; none, onboarding ends without one. */
      session?: CloudSession;
      /** Where to go without a session; home when unset. */
      next?: "home" | "import";
    };

export type CloudSession = {
  /** Its repository's GitHub id. */
  repoId: string;
  /** The user's own Claude, or Outrunner's models. */
  model: "claude" | "outrunner";
  /** A first message to send; onboarding opens the session without one. */
  prompt?: string;
};
