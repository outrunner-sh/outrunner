import assert from "node:assert/strict";
import { test } from "node:test";

import { listInstallationRepositoryRecords, mergeRepositoryLists, type GitHubRepository } from "@/lib/github/client";
import { connectRepositories, type ConnectDeps } from "@/lib/github/connect";
import { installationSettingsUrl } from "@/lib/github/listing";

function repo(id: number, fullName: string): GitHubRepository {
  const [owner, name] = fullName.split("/");
  return {
    githubRepoId: id,
    fullName,
    name,
    owner,
    ownerType: "User",
    avatarUrl: null,
    private: true,
    language: null,
    description: null,
    pushedAt: null,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${fullName}`,
  };
}

/** GitHub as one source sees it: these repositories, by id and by name. */
function deps(visible: GitHubRepository[]) {
  const upserted: GitHubRepository[][] = [];
  const d: ConnectDeps = {
    lookup: async (ref) =>
      visible.find((r) => (typeof ref === "number" ? r.githubRepoId === ref : r.fullName === ref)) ?? null,
    upsert: async (_owner, repositories) => {
      upserted.push(repositories);
      return repositories.length;
    },
  };
  return { d, upserted };
}

test("only repositories the source can see become projects, by id or name, in order", async () => {
  const a = repo(1, "ada/app");
  const b = repo(2, "ada/lib");
  const { d, upserted } = deps([a, b]);

  const result = await connectRepositories("owner", ["ada/lib", 99, 1, "ada/gone"], d);

  assert.deepEqual(result, { repositories: [b, a], synced: 2 });
  assert.deepEqual(upserted, [[b, a]]);
});

test("nothing is written when the source can see none of them", async () => {
  const { d, upserted } = deps([]);

  const result = await connectRepositories("owner", [7, "ada/private"], d);

  assert.deepEqual(result, { repositories: [], synced: 0 });
  assert.deepEqual(upserted, []);
});

test("installations' listings merge as one: each repository once, newest push first, complete only if all are", () => {
  const a = { ...repo(1, "ada/app"), pushedAt: "2026-10-01T00:00:00Z" };
  const b = { ...repo(2, "team/api"), pushedAt: "2026-10-20T00:00:00Z" };
  const c = repo(3, "team/old");
  const merged = mergeRepositoryLists([
    { repositories: [a, c], complete: true, ssoPartialOrgIds: [] },
    { repositories: [c, b], complete: false, ssoPartialOrgIds: [] },
  ]);
  assert.deepEqual(
    merged.repositories.map((r) => r.fullName),
    ["team/api", "ada/app", "team/old"],
  );
  assert.equal(merged.complete, false);
});

test("an installation's repositories are picked on its account's settings on GitHub", () => {
  assert.equal(
    installationSettingsUrl({ installationId: 9, login: "zerotrail", type: "Organization" }),
    "https://github.com/organizations/zerotrail/settings/installations/9",
  );
  assert.equal(
    installationSettingsUrl({ installationId: 9, login: "ada", type: "User" }),
    "https://github.com/settings/installations/9",
  );
});

test("an installation's repositories are read page by page, as many as GitHub says it has", async () => {
  const all = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    full_name: `team/r${i + 1}`,
    name: `r${i + 1}`,
    owner: { login: "team", type: "Organization" },
    html_url: `https://github.com/team/r${i + 1}`,
    default_branch: "main",
    private: true,
    pushed_at: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  }));
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}?page=${url.searchParams.get("page")}`);
    const page = Number(url.searchParams.get("page"));
    const records: unknown[] = all.slice((page - 1) * 100, page * 100);
    if (page === 2) records.push({ id: "not a repository" });
    return new Response(JSON.stringify({ total_count: 150, repositories: records }), { status: 200 });
  }) as typeof fetch;
  try {
    const list = await listInstallationRepositoryRecords("ghs_token");
    assert.equal(list.repositories.length, 150);
    assert.equal(list.repositories[0].owner, "team");
    assert.equal(list.repositories[0].ownerType, "Organization");
    // One record it couldn't read: some may be missing.
    assert.equal(list.complete, false);
    assert.deepEqual(asked.sort(), ["/installation/repositories?page=1", "/installation/repositories?page=2"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
