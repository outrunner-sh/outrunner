import assert from "node:assert/strict";
import { test } from "node:test";

import type { GitHubRepository, GitHubRepositoryList } from "@/lib/github/client";
import { planProjectReconcile } from "@/lib/github/reconcile";
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
    lost: [],
  });
});

test("new details, and a rename, are written back to the same project", () => {
  const renamed = repo(1, { fullName: "acme/new-name", name: "new-name", htmlUrl: "https://github.com/acme/new-name" });
  const pushed = repo(2, { pushedAt: "2026-10-02T00:00:00Z", defaultBranch: "trunk" });

  const plan = planProjectReconcile([project(1), project(2)], list([renamed, pushed]));

  assert.deepEqual(plan.refresh, [renamed, pushed]);
  assert.deepEqual(plan.lost, []);
});

test("a project GitHub stops listing is marked lost, once", () => {
  const plan = planProjectReconcile(
    [project(1), project(2), project(3, { accessLostAt: "2026-10-10T00:00:00Z" })],
    list([repo(1)]),
  );
  assert.deepEqual(plan.lost, [2]);
});

test("a lost project GitHub lists again is restored", () => {
  const plan = planProjectReconcile([project(1, { accessLostAt: "2026-10-10T00:00:00Z" })], list([repo(1)]));
  assert.deepEqual(plan.refresh, [repo(1)]);
});

test("a listing that may be short marks nothing lost, but still refreshes what it read", () => {
  const pushed = repo(1, { pushedAt: "2026-10-05T00:00:00Z" });
  for (const short of [{ complete: false }, { ssoPartialOrgIds: [42] }]) {
    const plan = planProjectReconcile([project(1), project(2)], list([pushed], short));
    assert.deepEqual(plan.lost, [], JSON.stringify(short));
    assert.deepEqual(plan.refresh, [pushed]);
  }
});
