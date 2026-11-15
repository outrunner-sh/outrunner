import assert from "node:assert/strict";
import { test } from "node:test";

import { GitIdentityError, resolveGitCredential, type IdentityDeps } from "@/lib/github/identity";
import { refreshConnectedGitHubNames, type ConnectedGitHubProject, type GitHubRepositoryName } from "@/lib/github/project-renames";

function project(id = "project", orgId = "org", githubRepoId: number | null = 42, fullName = "old-org/outrunner") {
  return {
    id, orgId, githubRepoId, fullName,
    owner: fullName.split("/")[0], name: fullName.split("/")[1],
    htmlUrl: `https://github.com/${fullName}`,
    ownerId: "original-connector", hidden: false,
  };
}

function store(rows = [project()]) {
  const writes: string[] = [];
  const deps = {
    // Returning every row also checks the coordinator's own org boundary.
    projects: async () => rows,
    rename: async (known: ConnectedGitHubProject, canonical: { fullName: string; owner: string; name: string; htmlUrl: string }) => {
      const row = rows.find((row) => row.id === known.id && row.orgId === known.orgId && row.githubRepoId === known.githubRepoId);
      if (!row) return false;
      Object.assign(row, canonical);
      writes.push(row.id);
      return true;
    },
  };
  return { rows, writes, deps };
}

const renamed = { githubRepoId: 42, fullName: "outrunner-sh/outrunner" };

test("an org rename reproduces both errors despite an installed, reachable GitHub App", async () => {
  const state = store();
  const minted: Array<{ repo: string; contents?: string }> = [];
  const access = new Map([["project", "write" as "read" | "write"]]);
  const identity: IdentityDeps = {
    identity: async () => "app",
    personalConnected: async () => true,
    personalToken: async () => { throw new Error("Must keep using the connected App"); },
    config: () => ({ clientId: "test", slug: "test", privateKey: "test", webhookSecret: "test" }),
    installations: async () => [{
      id: 7, accountLogin: "outrunner-sh", accountType: "Organization", repositorySelection: "all",
      suspendedAt: null, suspended: false, installedBy: "admin", createdAt: "2026-11-15T00:00:00Z",
    }],
    repoLevel: async (_user, org, repo) => {
      const row = state.rows.find((row) => row.orgId === org && row.fullName === repo);
      return row ? access.get(row.id) ?? null : null;
    },
    granted: async () => ({ contents: "write", pull_requests: "write", workflows: "write", metadata: "read" }),
    mint: async (_config, _installation, repo, permissions) => {
      minted.push({ repo, contents: permissions?.contents });
      return { token: "synthetic-installation-token", expiresAt: new Date(Date.now() + 3_600_000) };
    },
    cache: new Map(), now: Date.now,
  };
  const ask = { userId: "member", orgId: "org" };
  await assert.rejects(resolveGitCredential({ ...ask, repo: "old-org/outrunner" }, identity),
    (error: unknown) => error instanceof GitIdentityError && error.reason === "no_installation");
  await assert.rejects(resolveGitCredential({ ...ask, repo: renamed.fullName }, identity),
    (error: unknown) => error instanceof GitIdentityError && error.reason === "no_access");
  assert.equal(minted.length, 0);

  assert.equal(await refreshConnectedGitHubNames(["org"], [renamed], state.deps), 1);
  const credential = await resolveGitCredential({ ...ask, repo: renamed.fullName }, identity);
  assert.equal(credential.identity, "app");
  assert.deepEqual(minted, [{ repo: "outrunner", contents: "write" }]);
  assert.deepEqual(state.rows[0], {
    ...project(), fullName: renamed.fullName, owner: "outrunner-sh", htmlUrl: "https://github.com/outrunner-sh/outrunner",
  });

  // The existing project and its grants survive; a read-only member stays read-only.
  access.set("project", "read");
  await resolveGitCredential({ ...ask, repo: renamed.fullName }, identity);
  assert.equal(minted.at(-1)?.contents, "read");
});

test("repository renames follow stable IDs in linked orgs without connecting projects or taking ownership", async () => {
  const state = store([
    project(), project("shared", "shared-org"), project("unlinked", "another-org"),
    project("reused-name", "org", 99), project("gitlab", "org", null),
  ]);
  state.rows[1].hidden = true;
  const repositories = [renamed, { githubRepoId: 100, fullName: "outrunner-sh/not-connected" }];
  assert.equal(await refreshConnectedGitHubNames(["org", "shared-org"], repositories, state.deps), 2);
  assert.deepEqual(state.writes.sort(), ["project", "shared"]);
  assert.equal(state.rows.length, 5);
  assert.equal(state.rows[1].hidden, true);
  assert.ok(state.rows.every((row) => row.ownerId === "original-connector"));
  assert.equal(state.rows[2].fullName, "old-org/outrunner");
  assert.equal(state.rows[3].fullName, "old-org/outrunner");
  assert.equal(state.rows[4].fullName, "old-org/outrunner");
});

test("a different repository reusing a stored name cannot replace the connected repository's identity", async () => {
  const state = store();
  assert.equal(await refreshConnectedGitHubNames(["org"], [{ githubRepoId: 99, fullName: "old-org/outrunner" }], state.deps), 0);
  assert.equal(state.rows[0].githubRepoId, 42);
  assert.equal(state.rows[0].fullName, "old-org/outrunner");
  assert.deepEqual(state.writes, []);
});

test("partial listings, duplicate deliveries, and a missing scope never remove or reconnect projects", async () => {
  const state = store([project(), project("not-listed", "org", 99, "old-org/another")]);
  assert.equal(await refreshConnectedGitHubNames(["org", "org"], [renamed, renamed], state.deps), 1);
  assert.equal(await refreshConnectedGitHubNames(["org"], [renamed], state.deps), 0);
  assert.equal(state.rows[1].fullName, "old-org/another");
  assert.deepEqual(state.writes, ["project"]);
  const inaccessible = { ...state.deps, projects: async (): Promise<ConnectedGitHubProject[]> => { throw new Error("Unscoped read"); } };
  assert.equal(await refreshConnectedGitHubNames([], [renamed], inaccessible), 0);
  assert.equal(await refreshConnectedGitHubNames(["org"], [], inaccessible), 0);
});

test("invalid webhook identities are ignored before reading projects", async () => {
  const state = store();
  const invalid: GitHubRepositoryName[] = [
    { githubRepoId: 0, fullName: renamed.fullName },
    { githubRepoId: 1.5, fullName: renamed.fullName },
    { githubRepoId: 42, fullName: "https://example.com/not-github" },
  ];
  const deps = { ...state.deps, projects: async (): Promise<ConnectedGitHubProject[]> => { throw new Error("Invalid data read projects"); } };
  assert.equal(await refreshConnectedGitHubNames(["org"], invalid, deps), 0);
});

test("a persistence failure can be retried without repeating successful renames", async () => {
  const state = store([project(), project("second", "org", 43, "old-org/second")]);
  const repositories = [renamed, { githubRepoId: 43, fullName: "outrunner-sh/second" }];
  await assert.rejects(refreshConnectedGitHubNames(["org"], repositories, {
    ...state.deps,
    rename: async (row, canonical) => {
      if (row.id === "second") throw new Error("Database unavailable");
      return state.deps.rename(row, canonical);
    },
  }), /Database unavailable/);
  assert.equal(await refreshConnectedGitHubNames(["org"], repositories, state.deps), 1);
  assert.deepEqual(state.writes, ["project", "second"]);
});
