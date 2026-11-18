import assert from "node:assert/strict";
import { test } from "node:test";

import { listedFromRows, workRepoId } from "@/lib/environments/listed";

test("rows read as environments, the default marked, a malformed repository entry dropped", () => {
  const [acme, bare] = listedFromRows([
    {
      id: "e1",
      name: "Acme",
      default_for_project_id: null,
      org_default: true,
      repos: [{ projectId: "p1", fullName: "acme/web" }, { projectId: 7 }, null, { projectId: "p2", fullName: "acme/api" }],
    },
    { id: "e2", name: "web", default_for_project_id: "p1", org_default: null, repos: null },
  ]);
  assert.deepEqual(acme, {
    id: "e1",
    name: "Acme",
    defaultForProjectId: null,
    orgDefault: true,
    repos: [
      { projectId: "p1", fullName: "acme/web" },
      { projectId: "p2", fullName: "acme/api" },
    ],
  });
  assert.equal(bare.orgDefault, false);
  assert.deepEqual(bare.repos, []);
});

test("a session works in the repository it's the own environment of, else the first", () => {
  const repos = [
    { projectId: "p1", fullName: "acme/web" },
    { projectId: "p2", fullName: "acme/api" },
  ];
  assert.equal(workRepoId({ defaultForProjectId: "p2", repos }), "p2");
  assert.equal(workRepoId({ defaultForProjectId: null, repos }), "p1");
  assert.equal(workRepoId({ defaultForProjectId: null, repos: [] }), null);
});
