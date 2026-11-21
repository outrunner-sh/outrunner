"use client";

import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { newSessionAfterOnboarding } from "@/lib/onboarding/rules";
import type { AgentStatus, OnboardingEnv } from "@/lib/onboarding/types";

/**
 * The setup flow on mock data, with a panel to switch the situation it
 * meets: Claude already connected or not, the Mac app or a browser, GitHub
 * connected or not. For building the screens without an account; served
 * only with ONBOARDING_PREVIEW=1 outside production. The Repositories step
 * is the app's one repository picker, on the live listing: it shows no
 * repositories here unless signed in.
 */
export function OnboardingPreview() {
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [run, setRun] = useState(0);
  const env = useMemo(() => mockEnv(scenario), [scenario]);
  const set = (next: Partial<Scenario>) => {
    setScenario((current) => ({ ...current, ...next }));
    setRun((r) => r + 1);
  };
  return (
    <>
      <OnboardingFlow key={run} env={env} onLeave={(href) => window.alert(`Leaves for ${href}`)} />
      <Controls scenario={scenario} set={set} restart={() => setRun((r) => r + 1)} />
    </>
  );
}

type Scenario = {
  surface: "browser" | "desktop";
  claude: "none" | "subscription" | "api-key" | "connects-from-terminal";
  github: "app" | "available" | "none";
  outrunnerModels: "yes" | "no";
};

const DEFAULT_SCENARIO: Scenario = {
  surface: "browser",
  claude: "connects-from-terminal",
  github: "app",
  outrunnerModels: "yes",
};

const OPTIONS: { [K in keyof Scenario]: { label: string; values: [Scenario[K], string][] } } = {
  surface: { label: "Opened in", values: [["browser", "Browser"], ["desktop", "Mac app"]] },
  claude: {
    label: "Claude",
    values: [
      ["none", "Not connected"],
      ["connects-from-terminal", "Connects after 6s"],
      ["subscription", "Subscription"],
      ["api-key", "API key"],
    ],
  },
  github: { label: "GitHub", values: [["app", "App installed"], ["available", "Installed, not added"], ["none", "Not connected"]] },
  outrunnerModels: { label: "Outrunner models", values: [["yes", "On the server"], ["no", "Not set up"]] },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mockEnv(scenario: Scenario): OnboardingEnv {
  let gitlab: { login: string; updatedAt: string } | null = null;
  let accounts = scenario.github === "app" ? ["octocat"] : [];
  const opened = Date.now();
  const status: AgentStatus = {
    claude: {
      subscription: scenario.claude === "subscription",
      last4: scenario.claude === "subscription" ? "a1b2" : null,
      apiKey: scenario.claude === "api-key",
    },
    codex: { apiKey: false },
  };
  const current = (): AgentStatus =>
    scenario.claude === "connects-from-terminal" && Date.now() - opened > 6_000
      ? { ...status, claude: { ...status.claude, subscription: true, last4: "t3rm" } }
      : status;
  return {
    user: { id: "preview", name: "Mona", login: "octocat", avatarUrl: null },
    org: { id: "preview-org", name: "Acme" },
    desktop: scenario.surface === "desktop",
    outrunnerModels: scenario.outrunnerModels === "yes",
    agentStatus: async () => (await wait(300), current()),
    async saveClaudeToken() {
      await wait(500);
      status.claude.subscription = true;
      status.claude.last4 = "p4st";
      return current();
    },
    async saveApiKey(provider) {
      await wait(500);
      if (provider === "anthropic") status.claude.apiKey = true;
      else status.codex.apiKey = true;
      return current();
    },
    agentChoices: async () => (await wait(200), { claude: null, codex: null }),
    chooseMethod: async () => void (await wait(300)),
    async githubAccess() {
      await wait(200);
      return {
        admin: true,
        accounts,
        available: scenario.github === "available" && accounts.length === 0 ? [{ id: 42, accountLogin: "octocat" }] : [],
        personalGithub: false,
        appInstallable: true,
        installNeedsGithub: false,
      };
    },
    addInstallation: async () => {
      await wait(400);
      accounts = ["octocat"];
    },
    gitlabConnection: async () => gitlab,
    async saveGitlabConnection(token) {
      await wait(500);
      gitlab = token === null ? null : { login: "octocat", updatedAt: new Date().toISOString() };
      return gitlab;
    },
    createEnvironment: async () => (await wait(500), "preview-environment"),
    finish: async (environmentId, runOn) => (await wait(300), newSessionAfterOnboarding(environmentId, runOn)),
    skip: async () => (await wait(300), "/"),
    // Each run starts over: the panel's restart is the preview's reload.
    savedProgress: () => null,
    saveProgress: () => {},
  };
}

function Controls({ scenario, set, restart }: { scenario: Scenario; set: (next: Partial<Scenario>) => void; restart: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-popover/95 border-border/60 fixed right-4 bottom-4 z-50 w-64 rounded-lg border p-3 text-xs shadow-lg">
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setOpen((o) => !o)} className="font-medium">
          Onboarding preview
        </button>
        <button type="button" onClick={restart} aria-label="Restart" title="Restart">
          <RotateCcw className="size-3.5" />
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          {(Object.keys(OPTIONS) as (keyof Scenario)[]).map((key) => (
            <label key={key} className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{OPTIONS[key].label}</span>
              <select
                value={scenario[key]}
                onChange={(e) => set({ [key]: e.target.value } as Partial<Scenario>)}
                className="bg-transparent border-border/60 rounded border px-1 py-0.5"
              >
                {OPTIONS[key].values.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p className="text-muted-foreground">Changing a setting restarts the flow.</p>
        </div>
      )}
    </div>
  );
}
