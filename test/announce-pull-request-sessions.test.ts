/** The sessions a pull request is announced to, found by repository and
 *  branch — but only among the orgs that own the installation the event
 *  came from, and only on their project that is GitHub's own repository of
 *  it: another org's project renamed to collide with the repository (any
 *  member can rename one) must not have its sessions told of it. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeDb, type Row } from "./fake-supabase.ts";

import { sessionsOnRepoWith } from "@/lib/slack/announce-pull-request-sessions";

/** Org A's installation, its repository's sessions, and org B's session on a
 *  project its member renamed to collide with that repository. */
function db(withOrgBLink = false): { tables: Record<string, Row[]>; workspaceA: string; workspaceSeveral: string; workspaceB: string } {
  const workspaceA = "w-a";
  const workspaceSeveral = "w-several";
  const workspaceB = "w-b";
  return {
    workspaceA,
    workspaceSeveral,
    workspaceB,
    tables: {
      org_github_installation_details: [
        { org_id: "org-a", installation_id: 42, suspended_at: null },
        ...(withOrgBLink ? [{ org_id: "org-b", installation_id: 42, suspended_at: null }] : []),
      ],
      projects: [
        { id: "p-a", org_id: "org-a", full_name: "acme/private", github_repo_id: 501 },
        { id: "p-other", org_id: "org-a", full_name: "acme/other", github_repo_id: 503 },
        { id: "p-b", org_id: "org-b", full_name: "acme/private", github_repo_id: 502 },
      ],
      workspaces: [
        // A session of the repository itself, and one of several repositories
        // that checked it out: both of the installation's org.
        { id: workspaceA, org_id: "org-a", project_id: "p-a", branch: "feature/leak" },
        { id: workspaceSeveral, org_id: "org-a", project_id: "p-other", branch: "feature/leak", checkouts: [{ projectId: "p-a" }] },
        // Org B's session on the colliding project: its member renamed it to
        // the repository's full name.
        { id: workspaceB, org_id: "org-b", project_id: "p-b", branch: "feature/leak" },
        // A session of another org's on the branch: not one of the matched
        // projects' orgs, whatever a checkouts entry names.
        { id: "w-elsewhere", org_id: "org-c", project_id: "p-c", branch: "feature/leak", checkouts: [{ projectId: "p-a" }] },
      ],
      work_items: [],
    },
  };
}

test("the announcement reaches the installation's own org's sessions, of the repository and of its checkouts", async () => {
  const { tables, workspaceA, workspaceSeveral, workspaceB } = db();
  const found = await sessionsOnRepoWith(fakeDb(tables), 42, 501, "feature/leak");
  assert.ok(found.includes(workspaceA), "the repository's own session");
  assert.ok(found.includes(workspaceSeveral), "a session of several repositories that checked it out");
  assert.ok(!found.includes(workspaceB), "another org's colliding project's session");
  assert.ok(!found.includes("w-elsewhere"), "another org's session on the branch, of no matched project's org");
});

test("projects match by GitHub's repository id alone, never the full name", async () => {
  const { tables, workspaceA, workspaceSeveral, workspaceB } = db(true);
  // Org A's project renamed: still the repository, by its id.
  tables.projects.find((p) => p.id === "p-a")!.full_name = "acme/renamed";
  const found = await sessionsOnRepoWith(fakeDb(tables), 42, 501, "feature/leak");
  assert.ok(found.includes(workspaceA) && found.includes(workspaceSeveral));
  // Org B's same-named project, another repository, though the installation
  // is shared with its org: not reached.
  assert.ok(!found.includes(workspaceB));
  assert.deepEqual(await sessionsOnRepoWith(fakeDb(tables), 42, 999, "feature/leak"), []);
});

test("an org the installation is shared with is reached; a suspended or unowned installation reaches no one", async () => {
  const { tables, workspaceB } = db(true);
  // Org B's project of the repository itself — the same GitHub repository —
  // now that the installation is shared with its org.
  tables.projects.find((p) => p.id === "p-b")!.github_repo_id = 501;
  const found = await sessionsOnRepoWith(fakeDb(tables), 42, 501, "feature/leak");
  assert.ok(found.includes(workspaceB), "the installation is shared with org B");
  const suspended = db().tables;
  suspended.org_github_installation_details[0].suspended_at = "2026-11-05T00:00:00Z";
  assert.deepEqual(await sessionsOnRepoWith(fakeDb(suspended), 42, 501, "feature/leak"), []);
  const unclaimed = db().tables;
  assert.deepEqual(await sessionsOnRepoWith(fakeDb(unclaimed), 43, 501, "feature/leak"), []);
});
