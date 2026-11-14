import assert from "node:assert/strict";
import { test } from "node:test";

import { AUTO_PR_CODA, firstPrompt, parseCreate, PLAN_MODE_PREAMBLE, type CreateInput } from "@/lib/api/create-request";
import { pullRequestPreamble, pullRequestRef, repoFullName } from "@/lib/api/repo-ref";

test("a repository address names its project's full name", () => {
  for (const value of ["https://github.com/acme/web", "https://github.com/acme/web.git", "https://www.github.com/acme/web/", "github.com/acme/web", "git@github.com:acme/web.git", "ssh://git@github.com/acme/web.git", "acme/web"]) {
    assert.equal(repoFullName(value), "acme/web", value);
  }
  assert.equal(repoFullName("https://gitlab.com/group/sub/project"), "gitlab.com/group/sub/project");
  assert.equal(repoFullName("git@gitlab.com:group/project.git"), "gitlab.com/group/project");
});

test("an address of no repository names none", () => {
  for (const value of ["", "acme", "https://github.com/acme", "https://github.com/acme/web/pull/1", "https://bitbucket.org/acme/web", "https://evil.com/github.com/acme/web", "https://user:pw@github.com/acme/web", "https://gitlab.com/group/project/-/tree/main", "../x/y", 42, null]) {
    assert.equal(repoFullName(value), null, String(value));
  }
});

test("a pull request address names its repository and number", () => {
  assert.deepEqual(pullRequestRef("https://github.com/acme/web/pull/412"), { fullName: "acme/web", number: 412 });
  assert.deepEqual(pullRequestRef("https://github.com/acme/web/pull/412/files"), { fullName: "acme/web", number: 412 });
  assert.deepEqual(pullRequestRef("https://gitlab.com/group/sub/project/-/merge_requests/3/diffs"), { fullName: "gitlab.com/group/sub/project", number: 3 });
  for (const value of ["https://github.com/acme/web/issues/4", "https://github.com/acme/web/pull/0", "https://github.com/acme/web/pull/x", "https://gitlab.com/g/p/-/issues/3", "https://github.com/acme/web"]) {
    assert.equal(pullRequestRef(value), null, value);
  }
});

const create = (extra: Record<string, unknown>) => parseCreate({ prompt: "make the header sticky", ...extra });

test("a create names its repository by address, or a pull request", () => {
  const byUrl = create({ repo_url: "https://github.com/acme/web" }) as CreateInput;
  assert.equal(byUrl.repoFullName, "acme/web");
  assert.equal(byUrl.projectId, null);
  const byPr = create({ pr_url: "https://github.com/acme/web/pull/7", work_on_current_branch: true }) as CreateInput;
  assert.equal(byPr.repoFullName, "acme/web");
  assert.deepEqual(byPr.pullRequest, { fullName: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7" });
  assert.equal(byPr.workOnCurrentBranch, true);
  assert.equal(typeof create({ repo_url: "https://github.com/acme/web", pr_url: "https://github.com/acme/web/pull/7" }), "object");
});

test("names that disagree, or say too much, are refused", () => {
  assert.match(create({}) as string, /Name the repository/);
  assert.match(create({ repo_url: "https://github.com/acme/api", pr_url: "https://github.com/acme/web/pull/7" }) as string, /another repository/);
  assert.match(create({ repo_url: "https://github.com/acme/web", project_id: "11111111-1111-4111-8111-111111111111" }) as string, /Name one of/);
  assert.match(create({ repo_url: "ftp://x" }) as string, /repo_url/);
  assert.match(create({ pr_url: "https://github.com/acme/web/issues/7" }) as string, /pr_url/);
  assert.match(create({ pr_url: "https://github.com/acme/web/pull/7", base_branch: "main" }) as string, /leave out `base_branch`/);
  assert.match(create({ repo_url: "acme/web", work_on_current_branch: true }) as string, /base_branch/);
  assert.match(create({ repo_url: "acme/web", base_branch: "main", work_on_current_branch: true, branch: "x" }) as string, /leave out `branch`/);
  assert.match(create({ repo_url: "acme/web", auto_create_pr: "yes" }) as string, /auto_create_pr/);
  assert.match(create({ repo_url: "acme/web", name: "x".repeat(121) }) as string, /name/);
});

test("the first prompt says where the work goes, and to open a pull request when asked", () => {
  assert.equal(firstPrompt({ prompt: "do it", planMode: false, autoCreatePr: true }), `do it\n\n${AUTO_PR_CODA}`);
  assert.equal(firstPrompt({ prompt: "do it", planMode: true }), `${PLAN_MODE_PREAMBLE}\n\ndo it`);
  const pushed = firstPrompt({ prompt: "do it", planMode: false, workOnCurrentBranch: true, baseBranch: "release", autoCreatePr: true });
  assert.match(pushed, /^Push your commits to release itself/);
  assert.doesNotMatch(pushed, /open a pull request/);
  assert.equal(firstPrompt({ prompt: "do it", planMode: false }, "PR preamble"), "PR preamble\n\ndo it");
});

test("a session on a pull request is told which, and where to push", () => {
  const own = pullRequestPreamble({ url: "https://github.com/acme/web/pull/7", title: "Header", baseRef: "main", headRef: "feat/header", workOnPrBranch: true });
  assert.match(own, /pull\/7 "Header"/);
  assert.match(own, /git push origin HEAD:feat\/header/);
  assert.match(own, /Don't open another one/);
  const beside = pullRequestPreamble({ url: "u", title: "", baseRef: null, headRef: "feat/header", workOnPrBranch: false });
  assert.match(beside, /base it on feat\/header/);
});
