import assert from "node:assert/strict";
import { test } from "node:test";

import { needsSetup, setupGate } from "@/lib/orgs/setup";

/** An org as the database has it: nothing yet. */
const empty = { setupCompletedAt: null, hasWorkspace: false, environments: [] };
/** A repository's own environment, made on its first session. */
const own = (projectId: string) => ({ defaultForProjectId: projectId });
/** One someone made (setup's, or Environments' "New environment"). */
const made = { defaultForProjectId: null };

test("an empty org needs setup", () => {
  assert.equal(needsSetup(empty), true);
});

test("an org that has had a session doesn't, whatever its environments", () => {
  assert.equal(needsSetup({ ...empty, hasWorkspace: true }), false);
  assert.equal(needsSetup({ ...empty, hasWorkspace: true, environments: [own("p1"), own("p2")] }), false);
});

test("only repositories' own environments don't count as set up: they're made on first use", () => {
  assert.equal(needsSetup({ ...empty, environments: [own("p1"), own("p2")] }), true);
});

test("an environment someone made does", () => {
  assert.equal(needsSetup({ ...empty, environments: [own("p1"), made] }), false);
});

test("finished or skipped, it never needs it again, even emptied", () => {
  assert.equal(needsSetup({ ...empty, setupCompletedAt: "2026-11-18T00:00:00Z" }), false);
});

test("an admin is sent through setup; a member waits for one; set up, nothing", () => {
  const acme = { name: "Acme", personal: false };
  assert.deepEqual(setupGate(true, { ...acme, role: "admin" }), { kind: "setup" });
  assert.deepEqual(setupGate(true, { ...acme, role: "member" }), { kind: "waiting", orgName: "Acme" });
  assert.equal(setupGate(false, { ...acme, role: "admin" }), null);
  assert.equal(setupGate(false, { ...acme, role: "member" }), null);
});
