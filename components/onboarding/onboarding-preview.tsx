"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import type { OnboardingEnv, OnboardingRepo } from "@/lib/onboarding/types";

/**
 * The onboarding flow on mock data, with a panel to switch the situation it
 * meets: Mac app or browser, tools missing, Claude Code logged out, a Claude
 * connect that fails. For building the screens without an account; served only
 * with ONBOARDING_PREVIEW=1 outside production.
 */
export function OnboardingPreview() {
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  // A changed scenario restarts the flow from the top, as a new user would see it.
  const [run, setRun] = useState(0);
  const env = useMemo(() => mockEnv(scenario), [scenario]);

  const set = <K extends keyof Scenario>(key: K, value: Scenario[K]) => {
    setScenario((s) => ({ ...s, [key]: value }));
    setRun((r) => r + 1);
  };

  return (
    <>
      <OnboardingFlow key={run} env={env} />
      <Controls scenario={scenario} set={set} restart={() => setRun((r) => r + 1)} />
    </>
  );
}

type Scenario = {
  surface: "desktop" | "browser";
  tools: "all" | "no-tmux" | "no-claude" | "claude-setup-fails";
  claudeCode: "logged-in" | "logged-out" | "login-fails";
  claudeConnected: "no" | "yes";
  connect: "succeeds" | "no-subscription";
  repos: "many" | "few" | "none";
  imports: "some" | "none";
  outrunnerModels: "yes" | "no";
};

const DEFAULT_SCENARIO: Scenario = {
  surface: "desktop",
  tools: "all",
  claudeCode: "logged-out",
  claudeConnected: "no",
  connect: "succeeds",
  repos: "many",
  imports: "some",
  outrunnerModels: "yes",
};

const OPTIONS: { [K in keyof Scenario]: { label: string; values: [Scenario[K], string][] } } = {
  surface: { label: "Opened in", values: [["desktop", "Mac app"], ["browser", "Browser"]] },
  tools: {
    label: "Mac tools",
    values: [
      ["all", "All installed"],
      ["no-tmux", "No tmux"],
      ["no-claude", "No Claude Code"],
      ["claude-setup-fails", "Claude Code setup fails"],
    ],
  },
  claudeCode: {
    label: "Claude Code",
    values: [["logged-in", "Logged in"], ["logged-out", "Logged out"], ["login-fails", "Login fails"]],
  },
  claudeConnected: { label: "Claude for cloud", values: [["no", "Not connected"], ["yes", "Connected"]] },
  connect: { label: "Connect Claude", values: [["succeeds", "Succeeds"], ["no-subscription", "No subscription"]] },
  repos: { label: "GitHub repos", values: [["many", "Many"], ["few", "Two"], ["none", "None"]] },
  imports: { label: "Work to import", values: [["some", "Found"], ["none", "None"]] },
  outrunnerModels: { label: "Outrunner models", values: [["yes", "On the server"], ["no", "Not set up"]] },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const REPOS: OnboardingRepo[] = [
  "neevai-labs/outrunner",
  "neevai-labs/interface",
  "neevai-labs/neev-ai",
  "sajdakabir/dotfiles",
  "sajdakabir/blog",
  "neevai-labs/landing",
  "neevai-labs/docs",
  "sajdakabir/notes",
  "neevai-labs/infra",
].map((fullName, i) => ({
  id: String(i + 1),
  fullName,
  private: i % 3 !== 1,
  pushedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
}));

function mockEnv(s: Scenario): OnboardingEnv {
  // "Check again" after a missing tool finds it installed, as if the user ran
  // the command; a login that succeeds stays logged in.
  let checks = 0;
  let loggedIn = s.claudeCode === "logged-in";
  // The app setting up its own Claude Code: when it started, and whether the
  // scenario fails it partway.
  let setupStarted: number | null = null;
  const SETUP_MS = 6000;
  const noClaude = s.tools === "no-claude" || s.tools === "claude-setup-fails";
  let cancelled = false;
  return {
    user: { name: "Sajda Kabir", login: "sajdakabir", avatarUrl: null },
    desktop: s.surface === "desktop",
    outrunnerModels: s.outrunnerModels === "yes",
    async checkMac() {
      await wait(checks === 0 ? 900 : 300);
      const fixed = checks++ > 0;
      const elapsed = setupStarted === null ? 0 : Date.now() - setupStarted;
      const total = 75_949_326;
      const claudeSetup =
        setupStarted === null
          ? null
          : s.tools === "claude-setup-fails" && elapsed > SETUP_MS / 2
            ? { state: "failed" as const, message: "Couldn't download Claude Code: connection reset." }
            : elapsed < SETUP_MS
              ? { state: "installing" as const, received: Math.floor((total * elapsed) / SETUP_MS), total }
              : null;
      return {
        agent: true,
        git: true,
        tmux: fixed || s.tools !== "no-tmux",
        claude: !noClaude || (setupStarted !== null && claudeSetup === null),
        claudeLoggedIn: loggedIn,
        setsUpClaude: true,
        claudeSetup,
      };
    },
    async setUpClaudeCode() {
      setupStarted = Date.now();
    },
    async logInToClaudeCode() {
      cancelled = false;
      await wait(3000);
      if (cancelled) throw new Error("The Claude Code login was stopped. Try again.");
      if (s.claudeCode === "login-fails") {
        throw new Error("Claude Code couldn't log in. It said: OAuth error: access denied");
      }
      loggedIn = true;
    },
    cancelClaudeCodeLogin() {
      cancelled = true;
    },
    async pickFolder() {
      await wait(300);
      return { path: "/Users/sajdakabir/code/outrunner", name: "outrunner", git: true, branch: "main" };
    },
    async claudeConnected() {
      await wait(400);
      return s.claudeConnected === "yes";
    },
    async claudeOnMac() {
      await wait(900);
      return s.surface === "desktop" && !noClaude && s.claudeCode === "logged-in";
    },
    async connectClaude() {
      cancelled = false;
      await wait(3000);
      if (cancelled) throw new Error("Cancelled.");
      if (s.connect === "no-subscription") {
        throw new Error(
          "Claude Code stopped without issuing a token. Connecting needs a Claude Pro or Max subscription on the account you approve with.",
        );
      }
    },
    cancelConnectClaude() {
      cancelled = true;
    },
    async listRepos() {
      await wait(800);
      return s.repos === "none" ? [] : s.repos === "few" ? REPOS.slice(0, 2) : REPOS;
    },
    async findImports() {
      await wait(1500);
      return s.surface === "desktop" && s.imports === "some" ? { sessions: 14, sources: ["conductor", "claude-cli"] } : null;
    },
    async finish(input) {
      await wait(1500);
      window.alert(`Preview: would finish onboarding.\n\n${JSON.stringify(input, null, 2)}`);
      return null;
    },
  };
}

function Controls({
  scenario,
  set,
  restart,
}: {
  scenario: Scenario;
  set: <K extends keyof Scenario>(key: K, value: Scenario[K]) => void;
  restart: () => void;
}) {
  // Starts collapsed so it never covers the flow's own buttons in a narrow window.
  const [open, setOpen] = useState(false);
  return (
    <div className="border-border bg-popover/95 fixed bottom-4 right-4 z-50 w-64 rounded-lg border text-xs shadow-lg backdrop-blur">
      <div className="flex items-center justify-between px-3 py-2">
        <button type="button" onClick={() => setOpen((o) => !o)} className="font-medium">
          Onboarding preview
        </button>
        <div className="flex items-center gap-1">
          <button type="button" onClick={restart} title="Restart" className="hover:bg-accent rounded p-1">
            <RotateCcw className="size-3.5" />
          </button>
          <button type="button" onClick={() => setOpen((o) => !o)} className="hover:bg-accent rounded p-1">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        </div>
      </div>
      {open && (
        <div className="border-border space-y-2.5 border-t px-3 py-3">
          {(Object.keys(OPTIONS) as (keyof Scenario)[]).map((key) => (
            <label key={key} className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{OPTIONS[key].label}</span>
              <select
                value={scenario[key]}
                onChange={(e) => set(key, e.target.value as Scenario[typeof key])}
                className="border-border bg-background rounded border px-1.5 py-0.5"
              >
                {OPTIONS[key].values.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p className="text-muted-foreground pt-1">Changing a setting restarts the flow.</p>
        </div>
      )}
    </div>
  );
}
