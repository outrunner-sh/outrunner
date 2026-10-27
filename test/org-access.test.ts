import assert from "node:assert/strict";
import { test } from "node:test";

import { allows, type Grant, levelFrom, postedLevel, roleName } from "@/lib/orgs/access";

test("write allows read and write; read allows read; none allows nothing", () => {
  assert.equal(allows("write", "write"), true);
  assert.equal(allows("write", "read"), true);
  assert.equal(allows("read", "read"), true);
  assert.equal(allows("read", "write"), false);
  assert.equal(allows(null, "read"), false);
  assert.equal(allows(undefined, "read"), false);
});

test("a level as posted: read, write, or none to take it away; anything else isn't one", () => {
  assert.equal(postedLevel("read"), "read");
  assert.equal(postedLevel("write"), "write");
  assert.equal(postedLevel(null), null);
  assert.equal(postedLevel("none"), null);
  assert.equal(postedLevel("admin"), undefined);
  assert.equal(postedLevel(undefined), undefined);
});

test("a role's name is trimmed and 1 to 80 characters", () => {
  assert.equal(roleName("  Front   end "), "Front end");
  assert.equal(roleName(""), null);
  assert.equal(roleName("x".repeat(81)), null);
});

const grants: Grant[] = [
  { roleId: null, projectId: null, level: "read" },
  { roleId: "builders", projectId: "app", level: "write" },
  { roleId: "ops", projectId: null, level: "write" },
];

test("a member gets the highest level any grant that reaches them gives", () => {
  // Everyone: read on all.
  assert.equal(levelFrom(grants, [], "app"), "read");
  // A role's write on one project, and only there.
  assert.equal(levelFrom(grants, ["builders"], "app"), "write");
  assert.equal(levelFrom(grants, ["builders"], "api"), "read");
  // A role's write on all.
  assert.equal(levelFrom(grants, ["ops"], "api"), "write");
  // Nothing for Everyone: none without a role.
  assert.equal(levelFrom(grants.slice(1), [], "app"), null);
});
