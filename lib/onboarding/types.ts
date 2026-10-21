/**
 * What the onboarding flow needs from the world, as one adapter.
 *
 * The flow is UI only: every check and action goes through this, so the same
 * screens run on mock data (the preview, while the design settles) and later on
 * the real desktop bridge and APIs.
 */

import type { BillingInterval } from "@/lib/billing/plans";
import type { ClaudeSetup } from "@/lib/desktop/local-runtime";
import type { ImportProgress } from "@/lib/imports/client";
import type { ImportScan, ScannedSession } from "@/lib/runtime/import-scan";

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

export type OnboardingUser = {
  name: string;
  login: string;
  avatarUrl: string | null;
};

export type OnboardingEnv = {
  user: OnboardingUser;
  /** Inside the Outrunner Mac app, where This Mac works. */
  desktop: boolean;
  /** Whether a cloud session may start on Outrunner's models without Claude. */
  outrunnerModels: boolean;
  /** Plan prices in USD by Stripe lookup key; null where plans aren't sold. */
  prices: Record<string, number> | null;
  checkMac(): Promise<MacStatus>;
  /** Start setting up the app's own Claude Code; `checkMac` follows it. */
  setUpClaudeCode(): Promise<void>;
  /** Run `claude auth login`; resolves once the user approved in the browser. */
  logInToClaudeCode(): Promise<void>;
  cancelClaudeCodeLogin(): void;
  /** The folder dialog; null when cancelled. */
  pickFolder(): Promise<OnboardingFolder | null>;
  /** The Mac app's scan of what could come over from this Mac; null outside
   *  the app, or when the scan fails. */
  findImports(): Promise<ImportScan | null>;
  /** Import `sessions` to the cloud, their repositories connected as
   *  projects, reporting each one's progress. Rejects only when none could
   *  start; each session's own failure is its progress. */
  importSessions(sessions: ScannedSession[], onProgress: (progress: ImportProgress) => void): Promise<void>;
  /** Finish onboarding; resolves with where to go next, or null to stay. */
  finish(input: OnboardingFinish): Promise<string | null>;
  /** Leave onboarding without a session; absent where there is nothing to skip to. */
  skip?(): Promise<string>;
};

/**
 * How onboarding ends. On this Mac, in the first session there. In the cloud,
 * where the user chose on the plans step: home on the free plan, Settings →
 * Providers to bring their own models, or Stripe's checkout for a plan.
 */
export type OnboardingFinish =
  | {
      target: "mac";
      folder?: OnboardingFolder;
      /** A first message to send; onboarding opens the session without one. */
      prompt?: string;
    }
  | { target: "cloud"; next: CloudNext };

export type CloudNext =
  | { to: "home" }
  | { to: "providers" }
  | { to: "plan"; plan: "pro" | "max"; interval: BillingInterval };
