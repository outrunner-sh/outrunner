import type { FrameData } from "@/components/app-frame";
import type { Automation } from "@/lib/automations/rules";
import type { Environment } from "@/lib/db/environments";
import type { RunnerPullView } from "@/lib/missions/view";
import type { PullDetail, PullSummary } from "@/lib/review/pulls";
import type { Project, Workspace } from "@/lib/runtime/types";

export const project: Project = {
  id: "project-1",
  githubRepoId: 1,
  fullName: "neevai-labs/outrunner",
  owner: "neevai-labs",
  name: "outrunner",
  defaultBranch: "main",
  private: true,
  language: "TypeScript",
  description: null,
  htmlUrl: "https://github.com/neevai-labs/outrunner",
  pushedAt: null,
  linearIssueIds: [],
  orgId: "org-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
export const environment: Environment = {
  id: "environment-1",
  orgId: "org-1",
  name: "outrunner",
  description: "The environment for your next idea.",
  instructions:
    "Use pnpm. Run the relevant tests before opening a pull request.",
  repos: [
    {
      projectId: project.id,
      fullName: project.fullName,
      checkoutName: "outrunner",
      branch: null,
      defaultBranch: "main",
      position: 0,
      private: true,
    },
  ],
  envNames: ["API_TOKEN"],
  filePaths: [".env.local"],
  scripts: { setup: "pnpm install", run: "pnpm dev", archive: null },
  hooks: { warm: null, start: null },
  defaultForProjectId: project.id,
  setupGeneration: 0,
  warm: null,
  updatedAt: "2026-10-30T08:00:00Z",
  access: "write",
};

export const frame: FrameData = {
  ownerId: "preview-owner",
  ownerLogin: "immadsahin",
  ownerAvatarUrl: null,
  orgs: [],
  activeOrgId: null,
  triageCount: 0,
  appData: {
    coAuthor: "immad sahin <84772210+immadsahin@users.noreply.github.com>",
    projects: [project],
    hiddenProjects: [],
    pullRequests: {},
    standings: {},
    workspaces: [
      "Improve workspace navigation",
      "Polish the integrations page",
      "Review session loading",
    ].map(
      (title, i): Workspace => ({
        id: `preview-${i}`,
        projectId: project.id,
        ownerId: "preview-owner",
        provider: "daytona",
        status: "ready",
        phase: null,
        title,
        branch: `runtime/preview-${i}`,
        baseBranch: "main",
        worktreePath: "",
        sandboxId: null,
        volumeName: null,
        computerId: null,
        tmuxSession: null,
        agentWorkspaceId: null,
        environmentId: null,
        checkouts: null,
        agent: "claude",
        model: null,
        mode: "build",
        lastActiveAt: `2026-10-30T0${9 - i}:00:00Z`,
        errorMessage: null,
        createdAt: "2026-10-30T07:00:00Z",
        updatedAt: "2026-10-30T07:00:00Z",
      }),
    ),
  },
};

export const pulls: PullSummary[] = [
  [
    337,
    "Retain safe diagnostics for legacy snapshot failures",
    "outrunner-connector[bot]",
    "neevai-labs/outrunner",
  ],
  [
    335,
    "Organize scoped settings and read-only session info",
    "immadsahin",
    "neevai-labs/outrunner",
  ],
  [
    24,
    "Supercloud: reposition as the agent-native AI cloud",
    "immadsahin",
    "neevai-labs/neev-ai",
  ],
].map(([number, title, author, repo], i) => ({
  repo: String(repo),
  projectId: project.id,
  number: Number(number),
  title: String(title),
  author: String(author),
  draft: i === 1,
  updatedAt: "2026-10-30T09:00:00Z",
  url: `https://github.com/${repo}/pull/${number}`,
  checks: { passing: 3, pending: i === 0 ? 1 : 0, failing: 0 },
  lines:
    i === 1
      ? null
      : {
          code: { additions: 2534, deletions: 744 },
          test: { additions: 117, deletions: 0 },
          generated: { additions: 0, deletions: 0 },
        },
  linesComplete: i !== 0,
  sessionId: null,
  itemKey: null,
}));

export const pull: PullDetail = {
  ...pulls[0],
  title: "Sessions: archive and restore keep every chat",
  author: "immadsahin",
  state: "open",
  draft: false,
  body: "## A little more room for your work\n\nSessions now preserve every conversation when you archive and restore a workspace.\n\n### What changed\n\n- Restore your main chat and side conversations together.\n- Keep attachments and history in the same place.\n- Resume exactly where you left off.\n\n### Verification\n\nFocused tests cover archive, restore, and incomplete snapshots.",
  headRef: "sessions/preserve-conversations",
  baseRef: "main",
  headSha: "sha-1",
  fromFork: false,
  additions: 613,
  deletions: 45,
  changedFiles: 2,
  files: [
    {
      path: "lib/session/archive.ts",
      status: "modified",
      previousPath: null,
      additions: 2,
      deletions: 1,
      kind: "code",
      patch:
        "@@ -1,2 +1,3 @@\n-export const archived = false;\n+export const archived = true;\n+export const preserveChats = true;\n export const ready = true;",
    },
    {
      path: "test/archive.test.ts",
      status: "added",
      previousPath: null,
      additions: 2,
      deletions: 0,
      kind: "test",
      patch:
        "@@ -0,0 +1,2 @@\n+assert.equal(archived, true);\n+assert.equal(preserveChats, true);",
    },
  ],
  filesComplete: true,
  lines: {
    code: { additions: 2, deletions: 1 },
    test: { additions: 2, deletions: 0 },
    generated: { additions: 0, deletions: 0 },
  },
  checks: { passing: 7, failing: 0, pending: 0 },
  mergeableState: "clean",
  reviewers: ["reviewer"],
  reviews: [{ author: "outrunner-connector[bot]", state: "COMMENTED" }],
  reviewScore: "4/5",
  verdict: "PASS",
  ownSession: true,
};

export const runnerPull: RunnerPullView = {
  repo: project.fullName,
  number: 284,
  title: "Secondary panes",
  url: "https://github.com/neevai-labs/outrunner/pull/284",
  state: "merged",
  verdict: "ready",
  reason: null,
  additions: 120,
  deletions: 20,
  checks: [],
  reviewState: "approved",
  mergeableState: "clean",
  endedAt: "2026-10-30T09:00:00Z",
};
export const automations: Automation[] = [
  "Code Review",
  "Validate acceptance criteria",
].map((name, i) => ({
  id: `automation-${i}`,
  name,
  template: "code-review",
  prompt: "Review the pull request.",
  triggers: ["pull_request.opened", "pull_request.synchronize"],
  schedules: [],
  repos: [{ projectId: project.id, fullName: project.fullName }],
  enabled: true,
  reviewers: [],
  labels: [],
  maxRuns: null,
  archiveWhenDone: false,
  debounceSeconds: 60,
  sessionMode: "new",
  archived: false,
  runsUsed: 0,
  runsAs: null,
  target: { kind: "session" },
  createdAt: "2026-10-28T07:00:00Z",
}));
export const templates = [
  {
    id: "code-review",
    name: "Code Review",
    description: "Find bugs and improve code quality on every pull request.",
    category: "Code quality",
    triggers: ["pull_request.opened" as const],
  },
  {
    id: "validate",
    name: "Validate acceptance criteria",
    description:
      "Check the implementation against the work item's requirements.",
    category: "Validation",
    triggers: ["pull_request.opened" as const],
  },
];

/** A Personal org after a bulk import: 158 projects, the one with sessions
 *  (`project`) listed last so the picker must rank it first itself. */
export const manyProjects: Project[] = [
  ...Array.from({ length: 157 }, (_, i) => {
    const name = `imported-repo-${String(i + 1).padStart(3, "0")}`;
    return {
      ...project,
      id: `bulk-${i + 1}`,
      githubRepoId: 1000 + i,
      fullName: `immadsahin/${name}`,
      owner: "immadsahin",
      name,
      htmlUrl: `https://github.com/immadsahin/${name}`,
    };
  }),
  project,
];
