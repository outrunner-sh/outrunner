"use client";

import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import type { RepositoryListing } from "@/lib/github/listing";
import { OnboardingError } from "@/lib/onboarding/live-env";
import type { AgentStatus, OnboardingEnv } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";

/**
 * The onboarding flow on mock data, with a panel to switch the situation it
 * meets: Claude already connected or not, the Mac app or a browser, repos or
 * none, a session that starts or fails. For building the screens without an
 * account; served only with ONBOARDING_PREVIEW=1 outside production.
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
  repos: "some" | "none" | "github-error";
  start: "starts" | "fails";
  outrunnerModels: "yes" | "no";
};

const DEFAULT_SCENARIO: Scenario = {
  surface: "browser",
  claude: "connects-from-terminal",
  repos: "some",
  start: "starts",
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
  repos: { label: "GitHub", values: [["some", "Repositories"], ["none", "None"], ["github-error", "Token refused"]] },
  start: { label: "Session", values: [["starts", "Starts"], ["fails", "Fails"]] },
  outrunnerModels: { label: "Outrunner models", values: [["yes", "On the server"], ["no", "Not set up"]] },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const REPOS: RepositoryListing[] = [
  repo(1, "neevai-labs/outrunner", "Run coding agents in the cloud", true, "2026-10-25"),
  repo(2, "neevai-labs/interface", "The marketing site", true, "2026-10-20"),
  repo(3, "sajdakabir/blog", null, false, "2026-10-01"),
  repo(4, "immadsahin/millerp", "Rice mill accounting", true, "2026-09-12"),
];

function repo(id: number, fullName: string, description: string | null, isPrivate: boolean, pushedAt: string): RepositoryListing {
  const [owner, name] = fullName.split("/");
  return { githubRepoId: id, fullName, name, owner, ownerType: "User", avatarUrl: null, private: isPrivate, language: "TypeScript", description, pushedAt };
}

function project(r: RepositoryListing): Project {
  return {
    id: `p-${r.githubRepoId}`,
    githubRepoId: r.githubRepoId,
    fullName: r.fullName,
    owner: r.owner,
    name: r.name,
    defaultBranch: "main",
    private: r.private,
    language: r.language,
    description: r.description,
    htmlUrl: `https://github.com/${r.fullName}`,
    pushedAt: r.pushedAt,
    linearIssueIds: [],
    orgId: "",
    createdAt: "2026-10-25T00:00:00Z",
    updatedAt: "2026-10-25T00:00:00Z",
  };
}

function mockEnv(scenario: Scenario): OnboardingEnv {
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
    user: { id: "preview", name: "Sajda", login: "sajdakabir", avatarUrl: null },
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
        orgs: [{ id: "personal", name: "Personal", personal: true, admin: true, accounts: [] }],
        activeOrgId: "personal",
        personalGithub: scenario.repos !== "github-error",
        appInstallable: true,
        installNeedsGithub: false,
      };
    },
    useOrg: async () => void (await wait(200)),
    async repositories() {
      await wait(700);
      if (scenario.repos === "github-error") throw new OnboardingError("Your GitHub connection has expired. Sign out and back in to reconnect.");
      return { repositories: scenario.repos === "none" ? [] : REPOS, connected: [1] };
    },
    async connect(ids) {
      await wait(600);
      return REPOS.filter((r) => ids.includes(r.githubRepoId)).map(project);
    },
    async startSession(projectId, runOn) {
      await wait(800);
      if (scenario.start === "fails") {
        throw new OnboardingError("Your plan's 2 concurrent cloud sessions are already running.", "/upgrade");
      }
      return `/workspaces/new-on-${projectId}-${runOn}`;
    },
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
                className="bg-background border-border/60 rounded border px-1 py-0.5"
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
