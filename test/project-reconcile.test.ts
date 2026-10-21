import assert from "node:assert/strict";
import { test } from "node:test";

import type { GitHubRepository, GitHubRepositoryList } from "@/lib/github/client";
import { lookupWindow, planProjectReconcile, settleMissing } from "@/lib/github/reconcile";
import type { Project } from "@/lib/runtime/types";

function repo(id: number, over: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    githubRepoId: id,
    fullName: `acme/r${id}`,
    owner: "acme",
    ownerType: "Organization",
    avatarUrl: null,
    name: `r${id}`,
    defaultBranch: "main",
    private: true,
    language: "TypeScript",
    description: null,
    htmlUrl: `https://github.com/acme/r${id}`,
    pushedAt: "2026-10-01T10:00:00Z",
    ...over,
  };
}

/** The project a repository was connected as, as the database reads back. */
function project(id: number, over: Partial<Project> = {}): Project {
  const r = repo(id);
  return {
    id: `p${id}`,
    githubRepoId: id,
    fullName: r.fullName,
    owner: r.owner,
    name: r.name,
    defaultBranch: r.defaultBranch,
    private: r.private,
    language: r.language,
    description: r.description,
    htmlUrl: r.htmlUrl,
    // Postgres writes the same instant back differently.
    pushedAt: "2026-10-01T10:00:00+00:00",
    linearIssueIds: [],
    accessLostAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function list(repositories: GitHubRepository[], over: Partial<GitHubRepositoryList> = {}): GitHubRepositoryList {
  return { repositories, complete: true, ssoPartialOrgIds: [], ...over };
}

test("nothing changed on GitHub: nothing to write", () => {
  assert.deepEqual(planProjectReconcile([project(1), project(2)], list([repo(1), repo(2), repo(3)])), {
    refresh: [],
    missing: [],
  });
});

test("new details, and a rename, are written back to the same project", () => {
  const renamed = repo(1, { fullName: "acme/new-name", name: "new-name", htmlUrl: "https://github.com/acme/new-name" });
  const pushed = repo(2, { pushedAt: "2026-10-02T00:00:00Z", defaultBranch: "trunk" });

  const plan = planProjectReconcile([project(1), project(2)], list([renamed, pushed]));

  assert.deepEqual(plan.refresh, [renamed, pushed]);
  assert.deepEqual(plan.missing, []);
});

test("projects GitHub stops listing are reported missing, lost ones too (to look up again)", () => {
  const plan = planProjectReconcile(
    [project(1), project(2), project(3, { accessLostAt: "2026-10-10T00:00:00Z" })],
    list([repo(1)]),
  );
  assert.deepEqual(plan.missing, [2, 3]);
});

test("a lost project GitHub lists again is restored", () => {
  const plan = planProjectReconcile([project(1, { accessLostAt: "2026-10-10T00:00:00Z" })], list([repo(1)]));
  assert.deepEqual(plan.refresh, [repo(1)]);
});

test("a listing that may be short reports nothing missing, but still refreshes what it read", () => {
  const pushed = repo(1, { pushedAt: "2026-10-05T00:00:00Z" });
  for (const short of [{ complete: false }, { ssoPartialOrgIds: [42] }]) {
    const plan = planProjectReconcile([project(1), project(2)], list([pushed], short));
    assert.deepEqual(plan.missing, [], JSON.stringify(short));
    assert.deepEqual(plan.refresh, [pushed]);
  }
});

test("a missing project GitHub still shows on its own (public) isn't lost; one it doesn't is", () => {
  const publicRepo = repo(2, { private: false });
  const settled = settleMissing(
    [project(1), project(2), project(3, { accessLostAt: "2026-10-10T00:00:00Z" })],
    [1, 2, 3],
    [null, publicRepo, repo(3)],
  );
  // 2's details changed (now public); 3 was lost and is readable again.
  assert.deepEqual(settled, { refresh: [publicRepo, repo(3)], lost: [1] });
});

test("a failed lookup settles nothing for that project", () => {
  assert.deepEqual(settleMissing([project(1)], [1], [undefined]), { refresh: [], lost: [] });
});

test("lookups move round every missing project, a window at a time", () => {
  assert.deepEqual(lookupWindow([3, 1, 2], 5, 20), { ids: [1, 2, 3], nextCursor: 0 });

  const missing = [5, 4, 3, 2, 1];
  const seen: number[][] = [];
  let cursor = 0;
  for (let i = 0; i < 3; i += 1) {
    const batch = lookupWindow(missing, cursor, 2);
    seen.push(batch.ids);
    cursor = batch.nextCursor;
  }
  assert.deepEqual(seen, [
    [1, 2],
    [3, 4],
    [5, 1],
  ]);
});
