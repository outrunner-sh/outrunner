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
  repository: { full_name: "acme/private", id: 501 },
  pull_request: {
    number: 7,
    html_url: "https://github.com/acme/private/pull/7",
    title: "Private: the colliding org must not see this",
    state: "open",
    head: { ref: "fix", sha: "abc" },
    base: { ref: "main" },
  },
};

test("an event is read with the installation and repository it came from, and none without either", () => {
  const activity = activityOf("pull_request", payload);
  assert.equal(activity?.installationId, 42);
  assert.equal(activity?.repo, "acme/private");
  assert.equal(activity?.repoId, 501);
  assert.deepEqual(activity?.headRefs, ["fix"]);
  assert.equal(activity?.pr?.number, 7);
  assert.equal(activityOf("check_suite", { ...payload, check_suite: { head_branch: "fix", pull_requests: [{ number: 7 }] } })?.repoId, 501);
  // An event that names no installation can't be scoped to its orgs: no one's.
  assert.equal(activityOf("pull_request", { ...payload, installation: undefined }), null);
  assert.equal(activityOf("pull_request", { ...payload, installation: { id: "nope" } }), null);
  // Nor one whose payload names no repository id: projects match by it,
  // never by the full name (everything GitHub sends the webhook names one).
  assert.equal(activityOf("pull_request", { ...payload, repository: { full_name: "acme/private" } }), null);
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
      org_github_installation_details: [
        { org_id: "org-a", installation_id: 42, suspended_at: null },
        ...(withOrgBLink ? [{ org_id: "org-b", installation_id: 42, suspended_at: null }] : []),
      ],
      projects: [
        { id: "p-a", org_id: "org-a", full_name: "acme/private", github_repo_id: 501 },
        { id: "p-b", org_id: "org-b", full_name: "acme/private", github_repo_id: 502 },
      ],
      workspaces: [runner(runnerA, "org-a", "p-a"), runner(runnerB, "org-b", "p-b")],
      runner_pull_requests: [],
    },
  };
}

const activity = { installationId: 42, repo: "acme/private", repoId: 501, headRefs: ["fix"], numbers: [7] };

test("an event follows the installation's own org's Runner, never another org's colliding project's", async () => {
  const { tables, runnerA, runnerB } = db();
  const runners = await runnersForWith(fakeDb(tables), activity);
  assert.deepEqual(runners.map((r) => r.id), [runnerA]);
  assert.ok(runners.every((r) => r.orgId === "org-a"));
  assert.ok(!runners.some((r) => r.id === runnerB), "org B's Runner on the colliding project follows nothing of it");
});

test("an org the installation is shared with is reached; a suspended or unowned installation reaches no one", async () => {
  const { tables, runnerB } = db(true);
  // Org B's project of the repository itself — the same GitHub repository —
  // now that the installation is shared with its org.
  tables.projects.find((p) => p.id === "p-b")!.github_repo_id = 501;
  const runners = await runnersForWith(fakeDb(tables), activity);
  assert.ok(runners.some((r) => r.id === runnerB));
  const suspended = db().tables;
  suspended.org_github_installation_details[0].suspended_at = "2026-11-05T00:00:00Z";
  assert.deepEqual(await runnersForWith(fakeDb(suspended), activity), []);
  const unclaimed = db().tables;
  assert.deepEqual(await runnersForWith(fakeDb(unclaimed), { ...activity, installationId: 43 }), []);
});

test("a branch that is another session's own isn't a Runner's stacked work, though named after it", async () => {
  const { tables, runnerA } = db();
  // A plain session of the same repository on fix-2: a taken name numbered.
  tables.workspaces.push({ ...tables.workspaces[0], id: "plain", parent_mission_id: null, branch: "fix-2" });
  const onPlain = { ...activity, headRefs: ["fix-2"], numbers: [] };
  assert.deepEqual(await runnersForWith(fakeDb(tables), onPlain), []);
  // Stacked work no session has is still the Runner's.
  const stacked = { ...activity, headRefs: ["fix-3"], numbers: [] };
  assert.deepEqual((await runnersForWith(fakeDb(tables), stacked)).map((r) => r.id), [runnerA]);
});

test("a session's own branch counts only in the installation's orgs' projects of the repository", async () => {
  const { tables } = db();
  // Org B's project of the same GitHub repository (by id), outside the
  // installation; its plain session holds fix-2. Another org's sessions
  // never shape this one's: fix-2 is still read as r-a's stacked work.
  tables.projects.find((p) => p.id === "p-b")!.github_repo_id = 501;
  tables.workspaces.push({ ...tables.workspaces[1], id: "plain-b", parent_mission_id: null, branch: "fix-2" });
  const onPlain = { ...activity, headRefs: ["fix-2"], numbers: [] };
  assert.deepEqual((await runnersForWith(fakeDb(tables), onPlain)).map((r) => r.id), ["r-a"]);
  // A plain session of the repository in the installation's own org holds
  // fix-2 as its own branch, so it isn't r-a's.
  tables.workspaces.push({ ...tables.workspaces[0], id: "plain-a", parent_mission_id: null, branch: "fix-2" });
  assert.deepEqual(await runnersForWith(fakeDb(tables), onPlain), []);
});
