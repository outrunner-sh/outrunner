import assert from "node:assert/strict";
import { test } from "node:test";

import { commitImport, ImportError, type CommitDeps } from "@/lib/imports/commit";
import type { ImportCommitRequest } from "@/lib/runtime/import-scan";
import { parseManifest, type SnapshotManifest } from "@/lib/runtime/snapshot/manifest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const IMPORTED_AT = "2026-10-21T12:00:00.000Z";
const PREFIX = `archives/${OWNER}/${WORKSPACE}/2026-10-21T12-00-00-000Z/`;
const sha = (c: string) => `sha256:${c.repeat(64)}`;

function request(extra: Partial<ImportCommitRequest> = {}): ImportCommitRequest {
  return {
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    importedAt: IMPORTED_AT,
    key: "codex:s-1",
    source: "conductor",
    agent: "codex",
    sessionId: "s-1",
    branch: "feature-imported",
    bundleRef: "feature",
    title: "Fix login",
    worktree: "/Users/ada/app",
    startedAt: "2026-10-21T11:00:00.000Z",
    lastCommit: "a".repeat(40),
    unpushed: 2,
    changedFiles: 3,
    lastMessage: "Done.",
    artifacts: {
      bundle: { sha256: sha("1"), size: 100 },
      patch: { sha256: sha("2"), size: 20, encoding: "gzip" },
      conversation: { sha256: sha("3"), size: 300, encoding: "gzip" },
      rollout: { sha256: sha("4"), size: 400, encoding: "gzip" },
    },
    ...extra,
  };
}

/** Storage holding the uploads at the given sizes, and a record of writes. */
function deps(overrides: Partial<CommitDeps> = {}) {
  const writes: string[] = [];
  const objects = new Map<string, Buffer>();
  let manifest: SnapshotManifest | null = null;
  const d: CommitDeps = {
    getProject: async (id) => (id === PROJECT ? { id, defaultBranch: "main" } : null),
    branchesInUse: async () => new Set(["feature"]),
    workspaceExists: async () => false,
    storedSizes: async (prefix) =>
      prefix === PREFIX
        ? new Map([["worktree.bundle", 100], ["uncommitted.patch", 20], ["conversation.jsonl", 300], ["rollout.jsonl", 400]])
        : new Map(),
    putObject: async (path, body) => {
      writes.push(`put ${path.slice(PREFIX.length)}`);
      objects.set(path, body);
    },
    provider: async () => "daytona",
    insertWorkspace: async (row) => {
      writes.push(`workspace ${row.branch} ${row.agent} ${row.title}`);
    },
    insertSnapshot: async (row) => {
      manifest = row.manifest;
      writes.push(`snapshot ${row.storagePath === PREFIX}`);
    },
    insertImport: async (row) => {
      writes.push(`import ${row.key} ${row.conversationSha256 === sha("3")}`);
    },
    deleteWorkspace: async (id) => {
      writes.push(`delete ${id}`);
    },
    now: () => new Date("2026-10-21T12:05:00.000Z"),
    ...overrides,
  };
  return { d, writes, objects, manifest: () => manifest };
}

test("an imported session becomes an archived workspace whose Snapshot Restore can read", async () => {
  const { d, writes, objects, manifest } = deps();

  assert.deepEqual(await commitImport(OWNER, request(), d), { workspaceId: WORKSPACE });

  assert.deepEqual(writes, [
    "put summary.json",
    "put manifest.json",
    "workspace feature-imported codex Fix login",
    "snapshot true",
    "import codex:s-1 true",
  ]);
  const stored = parseManifest(JSON.parse(objects.get(`${PREFIX}manifest.json`)!.toString()));
  assert.deepEqual(stored, manifest());
  assert.equal(stored.cast, undefined);
  assert.equal(stored.rollout, "rollout.jsonl");
  assert.equal(stored.tree.kind === "git-bundle+patch" && stored.tree.ref, "feature");
  assert.deepEqual(stored.origin, { source: "conductor", key: "codex:s-1", worktree: "/Users/ada/app", importedAt: IMPORTED_AT });
  assert.deepEqual(stored.encodings, { "uncommitted.patch": "gzip", "conversation.jsonl": "gzip", "rollout.jsonl": "gzip" });
  assert.equal(stored.checksums["conversation.jsonl"], sha("3"));
  const summary = JSON.parse(objects.get(`${PREFIX}summary.json`)!.toString());
  assert.equal(stored.sizes["summary.json"], objects.get(`${PREFIX}summary.json`)!.length);
  assert.deepEqual([summary.duration, summary.commitCount, summary.lastAssistantMessage], [3600, 2, "Done."]);
});

test("an import that can't be trusted is refused before anything is written", async () => {
  const cases: Array<[string, Partial<ImportCommitRequest>, Partial<CommitDeps>, number]> = [
    ["another's project", { projectId: "44444444-4444-4444-8444-444444444444" }, {}, 404],
    ["an upload that didn't finish", {}, { storedSizes: async () => new Map([["worktree.bundle", 100]]) }, 409],
    ["a branch taken meanwhile", { branch: "feature", bundleRef: "feature" }, {}, 409],
    ["a plan from long ago", { importedAt: "2026-10-19T12:00:00.000Z" }, {}, 409],
    ["a Codex session with no rollout", { artifacts: { ...request().artifacts, rollout: undefined } }, {}, 400],
    ["a workspace that exists", {}, { workspaceExists: async () => true }, 409],
  ];
  for (const [name, extra, overrides, status] of cases) {
    const { d, writes } = deps(overrides);
    await assert.rejects(commitImport(OWNER, request(extra), d), (e: unknown) => e instanceof ImportError && e.status === status, name);
    assert.deepEqual(writes, [], name);
  }
});

test("a workspace whose Snapshot row fails is removed again", async () => {
  const { d, writes } = deps({
    insertSnapshot: async () => {
      throw new Error("db down");
    },
  });
  await assert.rejects(commitImport(OWNER, request(), d), /db down/);
  assert.deepEqual(writes.slice(-2), ["workspace feature-imported codex Fix login", `delete ${WORKSPACE}`]);
});
