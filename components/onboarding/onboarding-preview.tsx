"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import type { OnboardingEnv } from "@/lib/onboarding/types";
import type { ImportScan, ImportSource, ScannedSession } from "@/lib/runtime/import-scan";

/**
 * The onboarding flow on mock data, with a panel to switch the situation it
 * meets: Mac app or browser, tools missing, Claude Code logged out, work on
 * the Mac to import, plans on sale or not. For building the screens without an account; served only
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
  imports: "some" | "old" | "none";
  billing: "on" | "off";
  outrunnerModels: "yes" | "no";
};

const DEFAULT_SCENARIO: Scenario = {
  surface: "desktop",
  tools: "all",
  claudeCode: "logged-out",
  imports: "some",
  billing: "on",
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
  imports: { label: "Work to import", values: [["some", "Found"], ["old", "Only old"], ["none", "None"]] },
  billing: { label: "Plans", values: [["on", "On sale"], ["off", "Not sold"]] },
  outrunnerModels: { label: "Outrunner models", values: [["yes", "On the server"], ["no", "Not set up"]] },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DAY = 86_400_000;

/** A session the scan found: in `repo`, from `source`, last worked in `daysAgo`. */
function scanned(i: number, repo: string, source: ImportSource, daysAgo: number, title: string): ScannedSession {
  const agent = source === "codex-cli" ? "codex" : "claude";
  return {
    key: `${agent}:s${i}`,
    source,
    agent,
    sessionId: `s${i}`,
    title,
    cwd: `/Users/sajdakabir/code/${repo.split("/")[1]}`,
    worktree: `/Users/sajdakabir/code/${repo.split("/")[1]}`,
    repo,
    branch: `sajdakabir/${title.toLowerCase().split(" ").slice(0, 2).join("-")}`,
    checkedOut: true,
    dirty: i % 2 === 0,
    unpushed: i % 3,
    transcript: "/t",
    transcriptBytes: 40_000 * (i + 1),
    updatedAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
  };
}

const SESSIONS: ScannedSession[] = [
  scanned(1, "neevai-labs/outrunner", "conductor", 0.1, "Onboarding import step"),
  scanned(2, "neevai-labs/outrunner", "claude-cli", 2, "Fix sidebar refresh"),
  scanned(3, "neevai-labs/outrunner", "codex-cli", 6, "Plans step copy"),
  scanned(4, "neevai-labs/interface", "claude-cli", 1, "Dark mode tokens"),
  scanned(5, "neevai-labs/interface", "conductor", 45, "Old landing tweaks"),
  scanned(6, "sajdakabir/blog", "codex-cli", 12, "New post layout"),
  scanned(7, "neevai-labs/docs", "conductor", 90, "Docs migration"),
];

function mockScan(imports: Scenario["imports"]): ImportScan | null {
  if (imports === "none") return null;
  const sessions = imports === "old" ? SESSIONS.filter((s) => s.key.endsWith("5") || s.key.endsWith("7")) : SESSIONS;
  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    sources: [],
    sessions,
    projects: [],
    config: { items: [], mcpServers: [], plugins: [] },
  };
}

const PRICES = { pro_monthly: 20, pro_yearly: 200, max_monthly: 100, max_yearly: 1000 };

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
    prices: s.billing === "on" ? PRICES : null,
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
    async findImports() {
      await wait(1500);
      return s.surface === "desktop" ? mockScan(s.imports) : null;
    },
    async importSessions(sessions, onProgress) {
      // Each one uploads, then saves; the last one picked fails, to show how.
      for (const session of sessions) onProgress({ key: session.key, state: "waiting" });
      for (const [i, session] of sessions.entries()) {
        onProgress({ key: session.key, state: "uploading", branch: session.branch });
        await wait(900);
        onProgress({ key: session.key, state: "saving", branch: session.branch });
        await wait(400);
        onProgress(
          i === sessions.length - 1 && sessions.length > 1
            ? { key: session.key, state: "failed", message: "Couldn't upload its conversation. Try again." }
            : { key: session.key, state: "done", workspaceId: `w-${i}` },
        );
      }
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
