import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterRepositories,
  groupRepositories,
  parseGitHubRepoInput,
  type RepositoryListing,
} from "@/lib/github/listing";

test("a pasted repository reference becomes its owner/name", () => {
  const cases: Array<[string, string]> = [
    ["acme/tool", "acme/tool"],
    ["  acme/tool  ", "acme/tool"],
    ["https://github.com/acme/tool", "acme/tool"],
    ["https://github.com/acme/tool.git", "acme/tool"],
    ["https://github.com/acme/tool/", "acme/tool"],
    ["https://www.github.com/acme/tool/tree/main/src?x=1#readme", "acme/tool"],
    ["http://github.com/acme/tool", "acme/tool"],
    ["github.com/acme/tool", "acme/tool"],
    ["git@github.com:acme/tool.git", "acme/tool"],
    ["ssh://git@github.com/acme/tool.git", "acme/tool"],
    ["https://GitHub.com/Acme/Tool.js", "Acme/Tool.js"],
  ];
  for (const [input, expected] of cases) assert.equal(parseGitHubRepoInput(input), expected, input);
});

test("anything that isn't a GitHub repository is refused", () => {
  for (const input of [
    "",
    "acme",
    "acme/tool/extra",
    "https://gitlab.com/acme/tool",
    "https://github.com.evil.dev/acme/tool",
    "git@gitlab.com:acme/tool.git",
    "https://github.com/acme",
    "file:///github.com/acme/tool",
    "../etc",
    "acme/..",
    "-acme/tool",
    "acme/-tool",
    "ac me/tool",
  ]) {
    assert.equal(parseGitHubRepoInput(input), null, input);
  }
});

function repo(fullName: string, over: Partial<RepositoryListing> = {}): RepositoryListing {
  const [owner, name] = fullName.split("/");
  return {
    githubRepoId: fullName.length,
    fullName,
    name,
    owner,
    ownerType: "Organization",
    avatarUrl: null,
    private: false,
    language: null,
    description: null,
    pushedAt: null,
    ...over,
  };
}

test("the viewer's own repositories come first, then every other owner by name, each in listing order", () => {
  const repos = [
    repo("zeta/a"),
    repo("Me/newest", { ownerType: "User" }),
    repo("acme/x"),
    repo("me/older", { ownerType: "User", avatarUrl: "https://a/me" }),
    repo("Acme/y"),
  ];
  const groups = groupRepositories(repos, "me");
  assert.deepEqual(
    groups.map((g) => [g.owner, g.viewer, g.repos.map((r) => r.name)]),
    [
      ["Me", true, ["newest", "older"]],
      ["acme", false, ["x", "y"]],
      ["zeta", false, ["a"]],
    ],
  );
  // An avatar from any of an owner's repositories stands for the group.
  assert.equal(groups[0].avatarUrl, "https://a/me");
});

test("search matches the name, the owner and the description", () => {
  const repos = [repo("acme/api", { description: "Billing service" }), repo("neev/web")];
  assert.deepEqual(filterRepositories(repos, "BILLING").map((r) => r.fullName), ["acme/api"]);
  assert.deepEqual(filterRepositories(repos, "neev").map((r) => r.fullName), ["neev/web"]);
  assert.equal(filterRepositories(repos, "  ").length, 2);
});
