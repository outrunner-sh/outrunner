/** What a webhook says of one pull request, read with the installation it
 *  came from, and the Runners it can be about: the installation's own orgs'
 *  Runners only — another org's project renamed to collide with the
 *  repository (any member can rename one) must not have its Runners follow
 *  the repository's private pull requests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeDb, type Row } from "./fake-supabase.ts";

import { activityOf, runnersForWith } from "@/lib/missions/pull-request-activity";

const payload = {
  installation: { id: 42 },
  repository: { full_name: "acme/private" },
  pull_request: {
    number: 7,
    html_url: "https://github.com/acme/private/pull/7",
    title: "Private: the colliding org must not see this",
    state: "open",
    head: { ref: "fix", sha: "abc" },
    base: { ref: "main" },
  },
};

test("an event is read with the installation it came from, and none without one", () => {
  const activity = activityOf("pull_request", payload);
  assert.equal(activity?.installationId, 42);
  assert.equal(activity?.repo, "acme/private");
  assert.deepEqual(activity?.headRefs, ["fix"]);
  assert.equal(activity?.pr?.number, 7);
  assert.equal(activityOf("check_suite", { ...payload, check_suite: { head_branch: "fix", pull_requests: [{ number: 7 }] } })?.installationId, 42);
  // An event that names no installation can't be scoped to its orgs: no one's.
  assert.equal(activityOf("pull_request", { ...payload, installation: undefined }), null);
  assert.equal(activityOf("pull_request", { ...payload, installation: { id: "nope" } }), null);
});

/** Org A's installation, its repository's Runner, and org B's Runner on a
 *  project its member renamed to collide with that repository. */
function db(withOrgBLink = false): { tables: Record<string, Row[]>; runnerA: string; runnerB: string } {
  const runnerA = "r-a";
  const runnerB = "r-b";
  const runner = (id: string, orgId: string, projectId: string): Row => ({
    id,
    owner_id: `u-${id}`,
    org_id: orgId,
    project_id: projectId,
    parent_mission_id: `m-${id}`,
    branch: "fix",
    status: "idle",
    phase: null,
    provider: "local",
    checkouts: null,
  });
  return {
    runnerA,
    runnerB,
    tables: {
      org_github_installations: [{ org_id: "org-a", installation_id: 42 }, ...(withOrgBLink ? [{ org_id: "org-b", installation_id: 42 }] : [])],
      projects: [
        { id: "p-a", org_id: "org-a", full_name: "acme/private" },
        { id: "p-b", org_id: "org-b", full_name: "acme/private" },
      ],
      workspaces: [runner(runnerA, "org-a", "p-a"), runner(runnerB, "org-b", "p-b")],
      runner_pull_requests: [],
    },
  };
}

const activity = { installationId: 42, repo: "acme/private", headRefs: ["fix"], numbers: [7] };

test("an event follows the installation's own org's Runner, never another org's colliding project's", async () => {
  const { tables, runnerA, runnerB } = db();
  const runners = await runnersForWith(fakeDb(tables), activity);
  assert.deepEqual(runners.map((r) => r.id), [runnerA]);
  assert.ok(runners.every((r) => r.orgId === "org-a"));
  assert.ok(!runners.some((r) => r.id === runnerB), "org B's Runner on the colliding project follows nothing of it");
});

test("an org the installation is shared with is reached; an installation no org owns reaches no one", async () => {
  const { tables, runnerB } = db(true);
  const runners = await runnersForWith(fakeDb(tables), activity);
  assert.ok(runners.some((r) => r.id === runnerB));
  const unclaimed = db().tables;
  assert.deepEqual(await runnersForWith(fakeDb(unclaimed), { ...activity, installationId: 43 }), []);
});
