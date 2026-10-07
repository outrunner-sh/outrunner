import assert from "node:assert/strict";
import { test } from "node:test";

import { initialProjectId } from "@/lib/session/initial-project";

const projects = [{ id: "a" }, { id: "b" }];

test("with no repository requested, the form starts on the first", () => {
  assert.equal(initialProjectId(projects), "a");
  assert.equal(initialProjectId([]), "");
});

test("a requested repository that is listed is selected", () => {
  assert.equal(initialProjectId(projects, "b"), "b");
});

test("a requested repository that is not listed selects nothing, never another one", () => {
  assert.equal(initialProjectId(projects, "hidden"), "");
  assert.equal(initialProjectId(projects, ""), "");
  assert.equal(initialProjectId([], "b"), "");
});
