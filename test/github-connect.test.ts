import assert from "node:assert/strict";
import { test } from "node:test";

import type { GitHubRepository } from "@/lib/github/client";
import { connectRepositories, type ConnectDeps } from "@/lib/github/connect";

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

/** GitHub as one token sees it: these repositories, by id and by name. */
function deps(visible: GitHubRepository[]) {
  const upserted: GitHubRepository[][] = [];
  const d: ConnectDeps = {
    lookup: async (_token, ref) =>
      visible.find((r) => (typeof ref === "number" ? r.githubRepoId === ref : r.fullName === ref)) ?? null,
    upsert: async (_owner, repositories) => {
      upserted.push(repositories);
      return repositories.length;
    },
  };
  return { d, upserted };
}

test("only repositories the token can see become projects, by id or name, in order", async () => {
  const a = repo(1, "ada/app");
  const b = repo(2, "ada/lib");
  const { d, upserted } = deps([a, b]);

  const result = await connectRepositories("owner", "token", ["ada/lib", 99, 1, "ada/gone"], d);

  assert.deepEqual(result, { repositories: [b, a], synced: 2 });
  assert.deepEqual(upserted, [[b, a]]);
});

test("nothing is written when the token can see none of them", async () => {
  const { d, upserted } = deps([]);

  const result = await connectRepositories("owner", "token", [7, "ada/private"], d);

  assert.deepEqual(result, { repositories: [], synced: 0 });
  assert.deepEqual(upserted, []);
});
