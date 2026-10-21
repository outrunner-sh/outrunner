import { BILLING_PATH } from "@/lib/billing/checkout";
import { stripePage } from "@/lib/billing/client";
import {
  cancelClaudeLogin as cancelClaudeCodeLogin,
  importScan,
  localAgentRequest,
  localStatus,
  localTarget,
  logInToClaude,
  needsClaudeLogin,
  pickLocalFolder,
  putOnDefaultModel,
  rememberFolder,
  runsOnOutrunnerModel,
  setsUpClaude,
  setUpClaudeCode,
} from "@/lib/desktop/local-runtime";
import { importSessions } from "@/lib/imports/client";
import { liveImportDeps } from "@/lib/imports/live";
import { isDesktopApp } from "@/lib/is-desktop";
import type { CloudNext, OnboardingEnv, OnboardingFinish, OnboardingUser } from "@/lib/onboarding/types";
import { PROVIDERS_SETTINGS_HREF } from "@/lib/settings-links";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How often to ask whether Claude Code's login has landed. */
const LOGIN_CHECK_MS = 3000;

/**
 * Onboarding on the real thing: the Mac app's bridge for this Mac, and the
 * app's own APIs for the cloud. Each action is the same one the rest of the app
 * uses (the new-session form, the import page, Settings → Billing), not a
 * parallel copy.
 */
export function liveEnv(
  user: OnboardingUser,
  server: { outrunnerModels: boolean; prices: Record<string, number> | null },
): OnboardingEnv {
  let loginStopped = false;

  return {
    user,
    desktop: isDesktopApp(),
    // Whether a cloud session may start without the user's Claude, on
    // Outrunner's models: the server knows, from its OpenRouter key.
    outrunnerModels: server.outrunnerModels,
    prices: server.prices,

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

    async findImports() {
      // A scan that fails only means nothing is offered: /import scans again.
      return importScan().catch(() => null);
    },

    async importSessions(sessions, onProgress) {
      // Each session's repository becomes a project as the server plans it.
      await importSessions(sessions, {}, liveImportDeps(onProgress));
    },

    finish(input) {
      return input.target === "mac" ? startOnMac(input, server.outrunnerModels) : finishInCloud(input.next);
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
async function startOnMac(
  { prompt = "", folder }: Extract<OnboardingFinish, { target: "mac" }>,
  outrunnerModels: boolean,
): Promise<string> {
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
      await putOnDefaultModel(workspaceId);
    } catch (error) {
      // Not left to open on Claude Code's login screen.
      void localAgentRequest(target, "POST", `/workspaces/${workspaceId}/destroy`).catch(() => {});
      throw error;
    }
  }
  await markOnboarded();
  return `/local/${workspaceId}${promptQuery(prompt)}`;
}

/**
 * Leave onboarding where the user chose. A plan goes to Stripe's checkout,
 * which comes back to Settings → Billing; it is asked for before onboarding
 * is marked done, so a checkout that can't start leaves the user here to try
 * again. In the Mac app Stripe opens in the browser, and the app goes to
 * Billing to show the plan when they're back; in a browser this page is
 * leaving, so there is nowhere else to go.
 */
async function finishInCloud(next: CloudNext): Promise<string | null> {
  if (next.to === "plan") {
    const url = await stripePage("/api/billing/checkout", { plan: next.plan, interval: next.interval });
    await markOnboarded();
    window.location.assign(url);
    return isDesktopApp() ? BILLING_PATH : null;
  }
  await markOnboarded();
  return next.to === "providers" ? PROVIDERS_SETTINGS_HREF : "/";
}

/** The session page sends `?prompt=` as the first message; none, no query. */
function promptQuery(prompt: string): string {
  return prompt ? `?${new URLSearchParams({ prompt })}` : "";
}

async function markOnboarded(): Promise<void> {
  const res = await fetch("/api/onboarding/complete", { method: "POST" });
  if (!res.ok) {
    // The user is already on their way: a missed mark only shows onboarding again.
    console.error("Could not mark onboarding complete", res.status);
  }
}
