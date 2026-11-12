import assert from "node:assert/strict";
import { test } from "node:test";

import { prInstructions } from "@/lib/session/pr-instructions";
import { reviewInstructions } from "@/lib/session/review-instructions";
import { sessionRepo, sessionRepos } from "@/lib/session/session-repos";

const one = { projectId: "p1", baseBranch: "main", checkouts: null };
const several = {
  projectId: "p1",
  baseBranch: "main",
  checkouts: [
    { projectId: "p1", fullName: "acme/web", checkout: "web", baseBranch: "main" },
    { projectId: "p2", fullName: "acme/api", checkout: "api", baseBranch: "develop" },
  ],
};

test("a session of one repository has it, named by its project", () => {
  assert.deepEqual(sessionRepos(one), [{ projectId: "p1", fullName: null, checkout: null, baseBranch: "main" }]);
  assert.equal(sessionRepo(one, null)?.projectId, "p1");
  assert.equal(sessionRepo(one, "p2"), null);
});

test("a session of several names each, and refuses a repository not its own", () => {
  assert.deepEqual(
    sessionRepos(several).map((r) => r.checkout),
    ["web", "api"],
  );
  assert.equal(sessionRepo(several, "p2")?.baseBranch, "develop");
  assert.equal(sessionRepo(several, null)?.projectId, "p1");
  assert.equal(sessionRepo(several, "p9"), null);
});

test("a repository's PR and review stay in its folder", () => {
  const repo = { checkout: "api", fullName: "acme/api" };
  const more = { tools: { desktop: false }, footer: { sessionUrl: "https://app/workspaces/ws" } };
  const pr = prInstructions({ branch: "runtime/x", baseBranch: "develop", changedFiles: 2, repo, ...more });
  assert.match(pr, /for acme\/api only, the repository in the `api\/` folder/);
  assert.match(pr, /gh pr create --base develop/);
  assert.doesNotMatch(prInstructions({ branch: "b", baseBranch: "main", changedFiles: 0, ...more }), /folder/);
  const review = reviewInstructions({ baseBranch: "develop", pullRequestNumber: 7, repo });
  assert.match(review, /pull request #7 on acme\/api/);
  assert.match(review, /git -C api diff origin\/develop\.\.\./);
});
