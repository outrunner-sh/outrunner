import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { gitLabPath, repositoryKey, repositoryRemote } from "@/lib/code-providers/repository";
import { branchKnown, findPullRequest, getPullRequestStatus, getRepository, mergePullRequest } from "@/lib/code-providers/client";
import { getGitLabRepository, GitLabError, gitLabRequest, gitLabUser, listGitLabRepositories } from "@/lib/gitlab/client";
import { cloneMirror, pushBranch, type GitExec } from "@/lib/runtime/git";
import { deliverSessionSetup } from "@/lib/runtime/session-setup";

afterEach(() => mock.restoreAll());

const project = { id: 42, path_with_namespace: "acme/platform/app", path: "app", default_branch: "develop", visibility: "private", description: "App", last_activity_at: "2026-11-13T00:00:00Z" };
const mr = { iid: 7, web_url: "https://gitlab.com/acme/platform/app/-/merge_requests/7", title: "Fix app", target_branch: "develop", source_branch: "fix/app", source_project_id: 42, target_project_id: 42, state: "opened", sha: "a".repeat(40), detailed_merge_status: "mergeable", head_pipeline: { status: "success" } };

test("qualified GitLab paths preserve subgroups and reject traversal or foreign hosts", () => {
  assert.equal(gitLabPath("gitlab.com/acme/platform/app"), "acme/platform/app");
  assert.equal(repositoryRemote("gitlab.com/acme/platform/app"), "https://gitlab.com/acme/platform/app.git");
  assert.equal(repositoryRemote("acme/app"), "https://github.com/acme/app.git");
  for (const path of ["gitlab.com/acme/../app", "gitlab.com/acme//app", "gitlab.com/acme/app?x", "https://evil.test/a/b", "gitlab.com/acme/app.git"]) assert.throws(() => gitLabPath(path));
  assert.notEqual(repositoryKey({ githubRepoId: 42 }), repositoryKey({ githubRepoId: null, provider: "gitlab", repositoryId: 42 }));
});

test("GitLab listing keeps its identity separate from a GitHub id, including nested groups", async () => {
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(new URL(url).origin, "https://gitlab.com");
    assert.equal(new Headers(init.headers).get("private-token"), "glpat_private");
    assert.equal(init.redirect, "error");
    return Response.json([project], { headers: { "x-next-page": "" } });
  });
  const list = await listGitLabRepositories("glpat_private");
  assert.equal(list.complete, true);
  assert.equal(list.repositories[0].fullName, "gitlab.com/acme/platform/app");
  assert.equal(list.repositories[0].githubRepoId, null);
  assert.equal(list.repositories[0].repositoryId, 42);
  assert.equal(list.repositories[0].defaultBranch, "develop");
  assert.equal(list.repositories[0].private, true);
  assert.equal(calls.length, 1);
});

test("listing follows pages without trusting a host from response headers", async () => {
  let page = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    page++;
    assert.equal(new URL(url).origin, "https://gitlab.com");
    assert.equal(new URL(url).searchParams.get("page"), String(page));
    return Response.json([project], { headers: { "x-next-page": page === 1 ? "https://evil.test/" : "" } });
  });
  assert.equal((await listGitLabRepositories("secret")).repositories.length, 2);
});

test("repository lookup encodes the entire namespace, and 404 returns no project", async () => {
  mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.endsWith("/projects/acme%2Fplatform%2Fapp"));
    return Response.json(project);
  });
  assert.equal((await getRepository("glpat_secret", "gitlab.com/acme/platform/app"))?.repositoryId, 42);
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  assert.equal(await getGitLabRepository("secret", 42), null);
});

test("revoked tokens and provider errors have safe, actionable messages", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ secret: "do not expose me" }, { status: 401 }));
  await assert.rejects(gitLabUser("secret"), (error: unknown) => error instanceof GitLabError && error.status === 409 && error.message.includes("Reconnect GitLab") && !error.message.includes("do not expose"));
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => new Response("invalid JSON"));
  await assert.rejects(gitLabUser("secret"), /unreadable response/);
});

test("provider operations keep GitLab credentials on GitLab for branch and MR lookup, status and merge", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    assert.equal(new URL(url).origin, "https://gitlab.com");
    if (url.includes("/repository/branches/")) return new Response(null, { status: 404 });
    if (init.method === "PUT") { assert.deepEqual(JSON.parse(init.body as string), { sha: mr.sha }); return Response.json({ ...mr, state: "merged" }); }
    if (url.includes("source_branch=")) return Response.json([mr]);
    return Response.json(mr);
  });
  const input = { token: "glpat_secret", repoFullName: "gitlab.com/acme/platform/app" };
  assert.equal((await findPullRequest({ ...input, headBranch: "fix/app" }))?.number, 7);
  assert.equal(await branchKnown({ ...input, branch: "fix/app" }), true);
  assert.deepEqual(await getPullRequestStatus({ ...input, number: 7 }), { state: "open", draft: false, mergeableState: "clean", headSha: mr.sha, checks: { passing: 1, failing: 0, pending: 0 } });
  await mergePullRequest({ ...input, number: 7, headSha: mr.sha });
  assert.ok(seen.some(({ url }) => url.includes("source_branch=fix%2Fapp")));
});

test("GitLab clone and push use the correct remote and keep tokens out of argv", async () => {
  const calls: string[][] = [];
  const exec: GitExec = async (argv, options) => {
    calls.push(argv);
    assert.ok(!argv.join(" ").includes("glpat_secret"));
    if (argv.includes("fetch") || argv.includes("push")) assert.equal(options?.env?.RUNTIME_GIT_TOKEN, "glpat_secret");
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await cloneMirror(exec, { repoFullName: "gitlab.com/acme/platform/app", dir: "/repo.git", token: "glpat_secret" });
  await pushBranch(exec, { repoFullName: "gitlab.com/acme/platform/app", worktree: "/worktree", branch: "fix/app", token: "glpat_secret" });
  assert.equal(calls.filter((argv) => argv.includes("https://gitlab.com/acme/platform/app.git")).length, 2);
});

test("a merge request from a fork with the same branch name is never linked to the session", async () => {
  mock.method(globalThis, "fetch", async () => Response.json([{ ...mr, iid: 8, source_project_id: 99 }, mr]));
  const input = { token: "secret", repoFullName: "gitlab.com/acme/platform/app", headBranch: "fix/app" };
  assert.equal((await findPullRequest(input))?.number, 7);
});

test("a stale head or unmet approval requirement never marks a GitLab merge request merged", async () => {
  mock.method(globalThis, "fetch", async () => new Response(null, { status: 409 }));
  await assert.rejects(mergePullRequest({ token: "secret", repoFullName: "gitlab.com/acme/platform/app", number: 7, headSha: "a".repeat(40) }), GitLabError);
});

test("GitLab sessions upgrade old agents and refuse ones that cannot authenticate GitLab", async () => {
  let features: string[] = [];
  let upgraded = false;
  const client = { features: async () => features, upgrade: async () => { upgraded = true; features = ["gitlab-credential"]; }, setEnvironment: async () => {}, setAgentConfig: async () => {}, setAgentContext: async () => {}, setSkills: async () => ({ installed: [] }) };
  const setup = { gitlab: true, environment: null, agentConfig: null, downloadUrl: async () => "" };
  await deliverSessionSetup(client, setup);
  assert.equal(upgraded, true);
  features = [];
  await assert.rejects(deliverSessionSetup({ ...client, upgrade: undefined }, setup), /authenticate with GitLab/);
});

test("GitLab requests do not follow redirects or accept an arbitrary base URL", async () => {
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://gitlab.com/api/v4/user");
    assert.equal(init.redirect, "error");
    return Response.json({ id: 5, username: "ada" });
  });
  assert.equal((await gitLabJsonForTest()).username, "ada");
});

async function gitLabJsonForTest() {
  const response = await gitLabRequest("secret", "/user");
  return await response.json() as { username: string };
}
