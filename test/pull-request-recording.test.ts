/** A pull request event is recorded only on the sessions of the orgs that own
 *  the installation it came from, and only on their project that is GitHub's
 *  own repository of it. A project's full name is its org's members' to
 *  choose (any member can rename one), so another org's project renamed to
 *  collide with a repository — or the same-named project of a shared org's
 *  that is another repository — must never receive its private events. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeDb, type Row } from "./fake-supabase.ts";

import { recordPullRequestEventWith } from "@/lib/session/pull-request-recording";

/** Org A's installation, its repository and its session; and org B's session
 *  on a project its member renamed to collide with that repository. */
function db(withOrgBLink = false): { tables: Record<string, Row[]>; projectA: string; projectB: string; workspaceA: string; workspaceB: string; ownerA: string } {
  const projectA = "p-a";
  const projectB = "p-b";
  const workspaceA = "w-a";
  const workspaceB = "w-b";
  const ownerA = "u-a";
  return {
    projectA,
    projectB,
    workspaceA,
    workspaceB,
    ownerA,
    tables: {
      org_github_installation_details: [
        { org_id: "org-a", installation_id: 42, suspended_at: null },
        ...(withOrgBLink ? [{ org_id: "org-b", installation_id: 42, suspended_at: null }] : []),
      ],
      projects: [
        { id: projectA, org_id: "org-a", full_name: "acme/private", github_repo_id: 501 },
        { id: projectB, org_id: "org-b", full_name: "acme/private", github_repo_id: 502 },
      ],
      workspaces: [
        { id: workspaceA, owner_id: ownerA, org_id: "org-a", project_id: projectA, branch: "feature/leak", status: "active", checkouts: null },
        { id: workspaceB, owner_id: "u-b", org_id: "org-b", project_id: projectB, branch: "feature/leak", status: "active", checkouts: null },
      ],
      pull_requests: [],
    },
  };
}

const event = {
  repoId: 501,
  repoFullName: "acme/private",
  headRef: "feature/leak",
  baseRef: "main",
  number: 7,
  url: "https://github.com/acme/private/pull/7",
  title: "Private: the colliding org must not see this",
  state: "open" as const,
};

test("an event is recorded on the installation's own org's session, never on another org's colliding project", async () => {
  const { tables, projectA, workspaceA, ownerA } = db();
  const changed = await recordPullRequestEventWith(event, 42, fakeDb(tables));
  // Org A's session: told, and the pull request recorded on it.
  assert.deepEqual(changed, [{ workspaceId: workspaceA, ownerId: ownerA, from: null, to: "open", number: 7 }]);
  assert.deepEqual(
    tables.pull_requests.map((row) => ({ workspace_id: row.workspace_id, project_id: row.project_id, github_number: row.github_number, title: row.title })),
    [{ workspace_id: workspaceA, project_id: projectA, github_number: 7, title: event.title }],
  );
});

test("a project renamed to collide in another org receives nothing of the event, and neither does a same-named project that is another repository", async () => {
  const { tables, projectB, workspaceB } = db();
  await recordPullRequestEventWith(event, 42, fakeDb(tables));
  // Org B's project, renamed to org A's repository's full name by one of its
  // members: no pull request of org A's private repository is recorded on it.
  assert.equal(tables.pull_requests.filter((row) => row.project_id === projectB).length, 0);
  assert.ok(tables.pull_requests.every((row) => row.workspace_id !== workspaceB));
  // A shared org's project of the same name but another repository: not the
  // event's, even though its org owns the installation.
  const shared = db(true).tables;
  await recordPullRequestEventWith(event, 42, fakeDb(shared));
  assert.ok(shared.pull_requests.every((row) => row.project_id !== "p-b"), "matched GitHub's repository id, not the name");
});

test("projects match by GitHub's repository id alone, never the full name", async () => {
  const { tables, projectA, projectB, workspaceA } = db();
  // Org A's project renamed by one of its members: still the repository, by
  // its id, so still told.
  tables.projects.find((p) => p.id === projectA)!.full_name = "acme/renamed";
  const changed = await recordPullRequestEventWith(event, 42, fakeDb(tables));
  assert.deepEqual(changed.map((c) => c.workspaceId), [workspaceA]);
  assert.ok(tables.pull_requests.every((row) => row.project_id !== projectB));
  // And an id no project of the installation's orgs has reaches no one, the
  // full name matching or not.
  const none = db(true).tables;
  assert.deepEqual(await recordPullRequestEventWith({ ...event, repoId: 999 }, 42, fakeDb(none)), []);
  assert.equal(none.pull_requests.length, 0);
});

test("an org the installation is shared with does receive it; a suspended or unowned installation reaches no one", async () => {
  const shared = db(true).tables;
  // Org B's project of the repository itself — the same GitHub repository —
  // now that the installation is shared with its org.
  shared.projects.find((p) => p.id === "p-b")!.github_repo_id = 501;
  const changed = await recordPullRequestEventWith(event, 42, fakeDb(shared));
  assert.equal(changed.length, 2);
  assert.ok(changed.every((c) => c.to === "open" && c.number === 7));
  // A shared installation serves both orgs' projects of the repository.
  const suspended = db().tables;
  suspended.org_github_installation_details[0].suspended_at = "2026-11-05T00:00:00Z";
  assert.deepEqual(await recordPullRequestEventWith(event, 42, fakeDb(suspended)), []);
  assert.equal(suspended.pull_requests.length, 0);
  const unclaimed = db().tables;
  assert.deepEqual(await recordPullRequestEventWith(event, 43, fakeDb(unclaimed)), []);
  assert.equal(unclaimed.pull_requests.length, 0);
});
