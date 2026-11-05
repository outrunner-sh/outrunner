/** The sessions a pull request is announced to, found by repository and
 *  branch — but only among the orgs that own the installation the event
 *  came from: another org's project renamed to collide with the repository
 *  (any member can rename one) must not have its sessions told of it. */

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
      org_github_installations: [{ org_id: "org-a", installation_id: 42 }, ...(withOrgBLink ? [{ org_id: "org-b", installation_id: 42 }] : [])],
      projects: [
        { id: "p-a", org_id: "org-a", full_name: "acme/private" },
        { id: "p-other", org_id: "org-a", full_name: "acme/other" },
        { id: "p-b", org_id: "org-b", full_name: "acme/private" },
      ],
      workspaces: [
        // A session of the repository itself, and one of several repositories
        // that checked it out: both of the installation's org.
        { id: workspaceA, org_id: "org-a", project_id: "p-a", branch: "feature/leak" },
        { id: workspaceSeveral, org_id: "org-a", project_id: "p-other", branch: "feature/leak", checkouts: [{ projectId: "p-a" }] },
        // Org B's session on the colliding project: its member renamed it to
        // the repository's full name.
        { id: workspaceB, org_id: "org-b", project_id: "p-b", branch: "feature/leak" },
      ],
      work_items: [],
    },
  };
}

test("the announcement reaches the installation's own org's sessions, of the repository and of its checkouts", async () => {
  const { tables, workspaceA, workspaceSeveral, workspaceB } = db();
  const found = await sessionsOnRepoWith(fakeDb(tables), 42, "acme/private", "feature/leak");
  assert.ok(found.includes(workspaceA), "the repository's own session");
  assert.ok(found.includes(workspaceSeveral), "a session of several repositories that checked it out");
  assert.ok(!found.includes(workspaceB), "another org's colliding project's session");
});

test("an org the installation is shared with is reached; an installation no org owns reaches no one", async () => {
  const { tables, workspaceB } = db(true);
  const found = await sessionsOnRepoWith(fakeDb(tables), 42, "acme/private", "feature/leak");
  assert.ok(found.includes(workspaceB), "the installation is shared with org B");
  const unclaimed = db().tables;
  assert.deepEqual(await sessionsOnRepoWith(fakeDb(unclaimed), 43, "acme/private", "feature/leak"), []);
});
