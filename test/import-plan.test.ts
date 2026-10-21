import assert from "node:assert/strict";
import { test } from "node:test";

import type { GitHubRepository } from "@/lib/github/client";
import { chooseBranch, planImports, type PlanDeps } from "@/lib/imports/plan";
import type { ImportPlanRequest } from "@/lib/runtime/import-scan";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

function repo(fullName: string, id: number): GitHubRepository {
  const [owner, name] = fullName.split("/");
  return {
    githubRepoId: id, fullName, name, owner, ownerType: "User", avatarUrl: null, private: true,
    language: null, description: null, pushedAt: null, defaultBranch: "main", htmlUrl: `https://github.com/${fullName}`,
  };
}

/** A user who can see ada/app, whose project has `inUse` branches. */
function deps(inUse: string[], before: Record<string, string> = {}): PlanDeps & { minted: string[] } {
  let id = 0;
  const minted: string[] = [];
  return {
    minted,
    connect: async (names) => (names.includes("ada/app") ? [{ repository: repo("ada/app", 1), projectId: PROJECT }] : []),
    branchesInUse: async () => new Set(inUse),
    importedBefore: async (keys) => new Map(keys.filter((k) => before[k]).map((k) => [k, before[k]])),
    newId: () => `33333333-3333-4333-8333-33333333333${id++}`,
    now: () => new Date("2026-10-21T12:00:00.000Z"),
    mintUploads: async (paths) => {
      minted.push(...paths);
      return new Map(paths.map((p) => [p, `https://storage/upload/${p}`]));
    },
  };
}

function session(key: string, extra: Partial<ImportPlanRequest["sessions"][number]> = {}) {
  const agent = key.startsWith("codex:") ? ("codex" as const) : ("claude" as const);
  return { key, source: "conductor" as const, agent, repo: "ada/app", branch: "feature", ...extra };
}

test("a session gets a workspace, its own branch, and uploads under the owner's prefix", async () => {
  const d = deps([]);
  const [item] = await planImports(OWNER, { sessions: [session("codex:s-1")] }, d);

  assert.equal(item.status, "ready");
  if (item.status !== "ready") return;
  assert.equal(item.projectId, PROJECT);
  assert.equal(item.branch, "feature");
  assert.equal(item.renamed, false);
  const prefix = `archives/${OWNER}/${item.workspaceId}/2026-10-21T12-00-00-000Z/`;
  assert.deepEqual(Object.keys(item.uploads).sort(), ["bundle", "conversation", "patch", "rollout"]);
  assert.equal(item.uploads.conversation?.path, `${prefix}conversation.jsonl`);
  assert.ok(d.minted.every((p) => p.startsWith(prefix)));
});

test("a taken branch is imported under a free one; two picked sessions don't share one", async () => {
  const items = await planImports(
    OWNER,
    { sessions: [session("claude:a"), session("claude:b")] },
    deps(["feature", "feature-imported"]),
  );
  assert.deepEqual(
    items.map((i) => (i.status === "ready" ? [i.branch, i.renamed] : i.status)),
    [["feature-imported-2", true], ["feature-imported-3", true]],
  );
});

test("a branch the user named is used as it is, or the session is skipped", async () => {
  const items = await planImports(
    OWNER,
    { sessions: [session("claude:a", { branchAs: "mine" }), session("claude:b", { branchAs: "feature" })] },
    deps(["feature"]),
  );
  assert.equal(items[0].status === "ready" && items[0].branch, "mine");
  assert.equal(items[1].status === "skipped" && items[1].skip.reason, "branch-taken");
});

test("sessions that can't come say why, and get nothing minted", async () => {
  const d = deps([], { "claude:old": "2026-10-01T00:00:00Z" });
  const items = await planImports(
    OWNER,
    {
      sessions: [
        session("claude:old"),
        session("claude:other-repo", { repo: "bob/private" }),
        session("claude:old-again", {}),
      ],
    },
    { ...d, importedBefore: async () => new Map([["claude:old", "2026-10-01T00:00:00Z"]]) },
  );
  assert.equal(items[0].status === "skipped" && items[0].skip.reason, "already-imported");
  assert.equal(items[1].status === "skipped" && items[1].skip.reason, "no-repo-access");
  assert.equal(items[2].status, "ready");
  assert.equal(d.minted.length, 3);

  const again = await planImports(OWNER, { sessions: [session("claude:old", { again: true })] }, d);
  assert.equal(again[0].status, "ready");
});

test("a branch name Outrunner doesn't take is cleaned up", () => {
  assert.equal(chooseBranch("ada/naïve branch", new Set(), false), "ada/na-ve-branch-imported");
  assert.equal(chooseBranch("-x..y.lock", new Set(), false), "x.y-imported");
  assert.equal(chooseBranch("ok", new Set(), false), "ok");
});

test("a key named twice is planned once, and every key sent gets an item", async () => {
  const d = deps([]);
  const items = await planImports(
    OWNER,
    { sessions: [session("claude:s-1"), session("claude:s-1", { branchAs: "other" }), session("claude:s-2")] },
    d,
  );
  // One item per key, and one for each: a key with no item leaves the picker
  // showing "Waiting" for it forever.
  assert.deepEqual(
    items.map((i) => i.key),
    ["claude:s-1", "claude:s-2"],
  );
  // The repeat is ignored, not preferred: the first occurrence is planned.
  assert.equal(items[0].status === "ready" && items[0].branch, "feature");
  // And it didn't take a second workspace's worth of upload URLs.
  assert.equal(d.minted.length, 6);
});
