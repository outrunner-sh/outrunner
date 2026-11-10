/** A pull request event reaches only the automations of the orgs that own
 *  the installation it came from, on their project that is GitHub's own
 *  repository of it (lib/db/automation-pull-requests.ts). A project's full
 *  name is its org's members' to choose, so a same-named project that is
 *  another repository — even in an org the installation is shared with —
 *  must never start a run on the repository's pull requests, nor have its
 *  runs' sessions archived or checks closed by them. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeDb, type Row } from "./fake-supabase.ts";

import { openChecksOfPullRequestWith, pullRequestAutomationLinksWith, pullRequestSessionsWith } from "@/lib/db/automation-pull-requests";

/** Org A's repository (501) and its automation's runs on PR #7; org B's
 *  project of the same name, renamed by a member, that is another repository
 *  (502), with its own automation and runs on a #7. The installation is
 *  shared with org B unless `shared` is false. */
function db(shared = true): Record<string, Row[]> {
  return {
    org_github_installation_details: [
      { org_id: "org-a", installation_id: 42, suspended_at: null },
      ...(shared ? [{ org_id: "org-b", installation_id: 42, suspended_at: null }] : []),
    ],
    projects: [
      { id: "p-a", org_id: "org-a", full_name: "acme/private", github_repo_id: 501 },
      { id: "p-b", org_id: "org-b", full_name: "acme/private", github_repo_id: 502 },
    ],
    automation_repos: [
      { automation_id: "auto-a", project_id: "p-a" },
      { automation_id: "auto-b", project_id: "p-b" },
    ],
    automation_runs: [
      { id: "run-a", project_id: "p-a", pr_number: 7, workspace_id: "w-a", trigger: "pull_request.opened", check_run_id: 1, check_closed_at: null, check_reviewed_at: null },
      // The run its closing just started: its session is only beginning.
      { id: "run-a-closed", project_id: "p-a", pr_number: 7, workspace_id: "w-a-closed", trigger: "pull_request.closed", check_run_id: null, check_closed_at: null, check_reviewed_at: null },
      { id: "run-b", project_id: "p-b", pr_number: 7, workspace_id: "w-b", trigger: "pull_request.opened", check_run_id: 2, check_closed_at: null, check_reviewed_at: null },
    ],
    workspaces: [
      { id: "w-a", owner_id: "u-a", status: "ready" },
      { id: "w-a-closed", owner_id: "u-a", status: "ready" },
      { id: "w-b", owner_id: "u-b", status: "ready" },
    ],
  };
}

test("an event's automations are the repository's own, never a same-named project's that is another repository", async () => {
  const { links } = await pullRequestAutomationLinksWith(fakeDb(db()), 42, 501);
  assert.deepEqual(links, [{ automation_id: "auto-a", project_id: "p-a" }]);
  // Not shared: org B is out of scope, whatever its project is called.
  assert.deepEqual((await pullRequestAutomationLinksWith(fakeDb(db(false)), 42, 501)).links, [{ automation_id: "auto-a", project_id: "p-a" }]);
});

test("a pull request closing archives only the repository's runs' sessions and closes only their checks", async () => {
  const sessions = await pullRequestSessionsWith(fakeDb(db()), 42, 501, 7);
  // Org A's review session, not the one its closing started, and none of org B's.
  assert.deepEqual([...sessions], [["u-a", ["w-a"]]]);
  assert.deepEqual(await openChecksOfPullRequestWith(fakeDb(db()), 42, 501, 7), ["run-a"]);
});

test("a repository id no project of the installation's orgs has, or a suspended or unowned installation, reaches no one", async () => {
  assert.deepEqual((await pullRequestAutomationLinksWith(fakeDb(db()), 42, 999)).links, []);
  assert.deepEqual([...(await pullRequestSessionsWith(fakeDb(db()), 42, 999, 7))], []);
  assert.deepEqual(await openChecksOfPullRequestWith(fakeDb(db()), 42, 999, 7), []);
  const suspended = db();
  for (const holder of suspended.org_github_installation_details) holder.suspended_at = "2026-11-05T00:00:00Z";
  assert.deepEqual((await pullRequestAutomationLinksWith(fakeDb(suspended), 42, 501)).links, []);
  assert.deepEqual(await openChecksOfPullRequestWith(fakeDb(suspended), 42, 501, 7), []);
  assert.deepEqual((await pullRequestAutomationLinksWith(fakeDb(db()), 43, 501)).links, []);
});

test("org B's own repository reaches its automations, and not org A's", async () => {
  assert.deepEqual((await pullRequestAutomationLinksWith(fakeDb(db()), 42, 502)).links, [{ automation_id: "auto-b", project_id: "p-b" }]);
  assert.deepEqual([...(await pullRequestSessionsWith(fakeDb(db()), 42, 502, 7))], [["u-b", ["w-b"]]]);
  assert.deepEqual(await openChecksOfPullRequestWith(fakeDb(db()), 42, 502, 7), ["run-b"]);
});
