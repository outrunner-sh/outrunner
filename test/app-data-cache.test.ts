import assert from "node:assert/strict";
import { test } from "node:test";

import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { AppDataCache, cachedListFor, KEPT_CHARS, KEPT_WORKSPACES } from "@/lib/session/app-data-cache";
import type { AppData } from "@/lib/session/session-view";
import { deleteSession } from "@/lib/session/delete-session";

/** localStorage, with a quota in characters when given one. */
class FakeStorage {
  readonly items = new Map<string, string>();
  private readonly quota: number;
  constructor(quota = Infinity) {
    this.quota = quota;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    let used = value.length;
    for (const [k, v] of this.items) if (k !== key) used += v.length;
    if (used > this.quota) throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
}

function project(id: string): Project {
  return {
    id,
    orgId: "org-1",
    githubRepoId: 1,
    fullName: `me/${id}`,
    owner: "me",
    name: id,
    defaultBranch: "main",
    private: true,
    language: "TypeScript",
    description: null,
    htmlUrl: `https://github.com/me/${id}`,
    pushedAt: "2026-01-01T00:00:00.000Z",
    linearIssueIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    projectId: "p1",
    ownerId: "u1",
    provider: "daytona",
    status: "ready",
    phase: null,
    branch: `outrunner/${id}`,
    title: `Work on ${id}`,
    baseBranch: "main",
    worktreePath: `/work/${id}`,
    sandboxId: "box",
    volumeName: "vol",
    computerId: "computer",
    tmuxSession: `session-${id}`,
    agentWorkspaceId: id,
    environmentId: null,
    checkouts: null,
    agent: "claude",
    model: null,
    mode: "build",
    lastActiveAt: "2026-01-02T00:00:00.000Z",
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function pullRequest(id: string, workspaceId = id): WorkspacePullRequest {
  return {
    id: `pr-${id}`,
    workspaceId,
    projectId: "p1",
    number: 7,
    url: `https://github.com/me/p1/pull/7`,
    title: "A change",
    baseBranch: "main",
    headBranch: `outrunner/${workspaceId}`,
    createdAt: "2026-01-02T00:00:00.000Z",
    state: "open",
    stateAt: "2026-01-02T00:00:00.000Z",
  };
}

function list(overrides: Partial<AppData> = {}): AppData {
  return {
    projects: [project("p1")],
    hiddenProjects: [project("hidden")],
    workspaces: [workspace("w1"), workspace("w2")],
    pullRequests: { w1: pullRequest("w1") },
    ...overrides,
  };
}

function cache(storage: FakeStorage) {
  return new AppDataCache(() => storage);
}

test("the sidebar's list outlives the page", () => {
  const storage = new FakeStorage();
  cache(storage).save("org-1", list());

  // A reload: a new page, the same storage.
  const back = cache(storage).load();
  assert.equal(back?.pickedOrgId, "org-1");
  assert.deepEqual(back?.data.workspaces.map((w) => w.id), ["w1", "w2"]);
  assert.deepEqual(back?.data.hiddenProjects.map((p) => p.id), ["hidden"]);
  assert.equal(back?.data.pullRequests.w1?.number, 7);
});

test("the environments are kept with it, so the new-session form starts on the org's default at once", () => {
  const storage = new FakeStorage();
  const acme = { id: "e1", name: "Acme", defaultForProjectId: null, orgDefault: true, repos: [{ projectId: "p1", fullName: "acme/p1" }] };
  cache(storage).save("org-1", list({ environments: [acme] }));
  assert.deepEqual(cache(storage).load()?.data.environments, [acme]);
  // One kept before environments were: none, and the list still reads.
  cache(storage).save("org-1", list());
  assert.equal(cache(storage).load()?.data.environments, undefined);
});

test("where the kept sessions stood is kept with them, and nothing else a page reads", () => {
  const storage = new FakeStorage();
  const stood = { standing: "needs_you", reason: "question", moved: false, idle: true, pinned: false, unread: true, replyPreview: null, at: "t" } as const;
  cache(storage).save("org-1", {
    ...list(),
    standings: { w1: stood, gone: { ...stood, standing: "done", reason: null } },
  });
  const back = cache(storage).load()!;
  assert.deepEqual(Object.keys(back.data).sort(), ["hiddenProjects", "projects", "pullRequests", "standings", "workspaces"]);
  // Only the kept sessions': one the list doesn't have isn't kept.
  assert.deepEqual(back.data.standings, { w1: stood });
});

test("past the cap the least recently active go, and their pull requests with them", () => {
  const storage = new FakeStorage();
  const many = Array.from({ length: KEPT_WORKSPACES + 2 }, (_, i) => workspace(`w${i}`));
  cache(storage).save(null, list({ workspaces: many, pullRequests: { w0: pullRequest("w0"), [`w${KEPT_WORKSPACES + 1}`]: pullRequest("last") } }));

  const back = cache(storage).load()!;
  assert.equal(back.data.workspaces.length, KEPT_WORKSPACES);
  assert.equal(back.data.workspaces[0].id, "w0");
  assert.ok(back.data.pullRequests.w0);
  // One whose session isn't kept any more isn't kept either.
  assert.deepEqual(Object.keys(back.data.pullRequests), ["w0"]);
});

test("one kept by an older build, or damaged, opens from the server, and is dropped", () => {
  const storage = new FakeStorage();
  storage.setItem("outrunner:app-data", JSON.stringify({ v: 0, pickedOrgId: null, data: {} }));
  assert.equal(cache(storage).load(), null);
  storage.setItem("outrunner:app-data", "{not json");
  assert.equal(cache(storage).load(), null);
  // A list missing what every reader needs: a session with no id.
  storage.setItem("outrunner:app-data", JSON.stringify({ v: 2, pickedOrgId: null, data: { projects: [], hiddenProjects: [], workspaces: [{ projectId: "p1" }], pullRequests: {} } }));
  assert.equal(cache(storage).load(), null);
  assert.equal(storage.getItem("outrunner:app-data"), null);
});

test("a list too long to keep isn't kept, and no older list stands in for it", () => {
  const storage = new FakeStorage();
  cache(storage).save(null, list());
  assert.ok(cache(storage).load());
  cache(storage).save(null, list({ workspaces: [workspace("w1", { title: "x".repeat(KEPT_CHARS) })] }));
  assert.equal(cache(storage).load(), null);
  assert.equal(storage.getItem("outrunner:app-data"), null);
});

test("out of room nothing is kept, and no older list stands in for it", () => {
  const storage = new FakeStorage(10);
  assert.equal(cache(storage).save(null, list()), null);
  assert.equal(storage.getItem("outrunner:app-data"), null);
  assert.equal(cache(storage).load(), null);
});

test("the same list written twice isn't written again", () => {
  const storage = new FakeStorage();
  const store = cache(storage);
  assert.equal(store.save("org-1", list())?.changed, true);
  assert.equal(store.save("org-1", list())?.changed, false);
  assert.equal(store.save(null, list())?.changed, true); // another org's list
  assert.equal(store.load()?.pickedOrgId, null);
});

test("deleting a session forgets it from the kept list, and signing out forgets them all", () => {
  const storage = new FakeStorage();
  const store = cache(storage);
  store.save("org-1", list());
  store.forget("w1");
  const back = store.load()!;
  assert.deepEqual(back.data.workspaces.map((w) => w.id), ["w2"]);
  assert.deepEqual(back.data.pullRequests, {});
  store.clear();
  assert.equal(storage.getItem("outrunner:app-data"), null);
});

test("a list kept for another org is never shown", () => {
  const kept = { pickedOrgId: "org-1", data: list() };
  assert.equal(cachedListFor(kept, "org-1")?.workspaces.length, 2);
  // The switcher hasn't been used, or the cookie hasn't landed yet: the list
  // is the user's own, and shows.
  assert.equal(cachedListFor(kept, null)?.workspaces.length, 2);
  assert.equal(cachedListFor(kept, undefined)?.workspaces.length, 2);
  // Another org is the one being looked at: the server's list is the only one.
  assert.equal(cachedListFor(kept, "org-2"), null);
  assert.equal(cachedListFor(null, "org-1"), null);
});

test("blocked storage keeps nothing and breaks nothing", () => {
  const store = new AppDataCache(() => null);
  assert.equal(store.save(null, list()), null);
  assert.equal(store.load(), null);
});

test("deleting a session drops it from this browser's kept list", async () => {
  const storage = new FakeStorage();
  cache(storage).save("org-1", list());
  (globalThis as Record<string, unknown>).window = {
    localStorage: storage,
    __RUNTIME_DESKTOP__: true,
    __TAURI__: {
      core: {
        invoke: () => Promise.resolve({}),
        Channel: class {},
      },
    },
  };
  await deleteSession("w1", { kind: "local-worktree" });
  const back = cache(storage).load()!;
  assert.deepEqual(back.data.workspaces.map((w) => w.id), ["w2"]);
});
