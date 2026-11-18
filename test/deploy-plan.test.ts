import assert from "node:assert/strict";
import { test } from "node:test";

import { decide, gather, runState } from "../deploy/plan.mjs";

const sha = "a".repeat(40);
const tree = "t".repeat(40);
const image = `ghcr.io/outrunner-sh/outrunner/control-plane:tree-${tree}`;
const state = (over: object = {}) => ({
  event: "push", sha, head: sha, tree, image, testedBy: null, mainCI: "pending", imageExists: false, buildOnVm: false, ...over,
});

test("a merge tested as is, its image built, deploys at once", () => {
  assert.deepEqual(decide(state({ testedBy: 12, imageExists: true })), { action: "deploy", image });
});

test("a merge whose pull request was behind main waits for main's CI, then deploys", () => {
  assert.equal(decide(state()).action, "wait");
  assert.equal(decide(state({ mainCI: "success", imageExists: true })).action, "deploy");
  assert.equal(decide(state({ mainCI: "failure" })).action, "fail");
});

test("a tested tree whose image isn't built yet waits for main's run to build it", () => {
  assert.match((decide(state({ testedBy: 12 })) as { why: string }).why, /image of tree/);
  // main's CI passed and still no image: something's wrong; say so.
  assert.equal(decide(state({ testedBy: 12, mainCI: "success" })).action, "fail");
});

test("an automatic run for a commit no longer main's head stands down", () => {
  assert.equal(decide(state({ head: "b".repeat(40), testedBy: 12, imageExists: true })).action, "stand-down");
  // A rollback by hand deploys an older commit on purpose.
  assert.equal(decide(state({ event: "workflow_dispatch", head: "b".repeat(40), mainCI: "success", imageExists: true })).action, "deploy");
});

test("a rollback to a commit from before images builds on the VM; one CI never passed doesn't deploy", () => {
  assert.deepEqual(decide(state({ event: "workflow_dispatch", mainCI: "success" })), { action: "deploy", image: "" });
  assert.equal(decide(state({ event: "workflow_dispatch", mainCI: "none" })).action, "fail");
});

test("with the VM build path switched back on, nothing waits for an image", () => {
  assert.deepEqual(decide(state({ testedBy: 12, buildOnVm: true })), { action: "deploy", image: "" });
});

test("a commit's CI state is its newest run's: a re-run supersedes a flake", () => {
  const run = (created_at: string, status: string, conclusion: string | null) => ({ created_at, status, conclusion });
  assert.equal(runState([]), "none");
  assert.equal(runState([run("2026-11-18T10:00:00Z", "completed", "failure"), run("2026-11-18T10:05:00Z", "completed", "success")]), "success");
  assert.equal(runState([run("2026-11-18T10:05:00Z", "in_progress", null), run("2026-11-18T10:00:00Z", "completed", "success")]), "pending");
  assert.equal(runState([run("2026-11-18T10:00:00Z", "completed", "cancelled")]), "failure");
});

// From GitHub's answers: the merge's tree, its pull request's head's tree,
// and that head's pull_request run.
function fakeGithub({ headTree, prRun }: { headTree: string; prRun: string }) {
  const answers: Record<string, unknown> = {
    "/repos/o/r/commits/main": { sha },
    [`/repos/o/r/git/commits/${sha}`]: { tree: { sha: tree } },
    [`/repos/o/r/commits/${sha}/pulls`]: [{ number: 12, merged_at: "2026-11-18T10:00:00Z", head: { sha: "c".repeat(40) } }],
    [`/repos/o/r/git/commits/${"c".repeat(40)}`]: { tree: { sha: headTree } },
    [`/repos/o/r/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`]: { workflow_runs: [] },
    [`/repos/o/r/actions/workflows/ci.yml/runs?head_sha=${"c".repeat(40)}&event=pull_request&per_page=20`]:
      { workflow_runs: [{ created_at: "2026-11-18T09:00:00Z", status: "completed", conclusion: prRun }] },
  };
  return async (path: string) => {
    if (!(path in answers)) throw new Error(`unexpected ${path}`);
    return answers[path];
  };
}

test("a pull request tested the merge only if its head has the merge's very tree, and its run passed", async () => {
  const input = (github: (path: string) => Promise<unknown>) =>
    ({ github, registry: async () => true, repo: "o/r", event: "push", sha, buildOnVm: false });
  assert.equal((await gather(input(fakeGithub({ headTree: tree, prRun: "success" })))).testedBy, 12);
  assert.equal((await gather(input(fakeGithub({ headTree: "u".repeat(40), prRun: "success" })))).testedBy, null, "behind main: another tree");
  assert.equal((await gather(input(fakeGithub({ headTree: tree, prRun: "failure" })))).testedBy, null);
  const s = await gather(input(fakeGithub({ headTree: tree, prRun: "success" })));
  assert.equal(s.image, `ghcr.io/o/r/control-plane:tree-${tree}`);
});
