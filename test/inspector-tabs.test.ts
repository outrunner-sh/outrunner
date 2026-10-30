import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProviderName } from "@/lib/runtime/types";
import { inspectorTabs, shownTab } from "@/lib/session/inspector-tabs";

const ids = (provider: ProviderName, local = false, kind?: "session" | "mission") =>
  inspectorTabs({ provider, kind }, local).map((tab) => tab.id);

test("a cloud session on Daytona has top-level Changes, Desktop and Canvas tabs", () => {
  assert.deepEqual(ids("daytona"), ["environment", "changes", "desktop", "canvas"]);
  assert.deepEqual(ids("user-daytona"), ["environment", "changes", "desktop", "canvas"]);
});

test("a session whose box has no desktop still offers its supported panels", () => {
  for (const provider of ["neev", "user-modal"] as ProviderName[]) {
    assert.deepEqual(ids(provider), ["environment", "changes", "canvas"], provider);
  }
  for (const provider of ["modal", "local"] as ProviderName[]) {
    assert.deepEqual(ids(provider), ["environment", "changes"], provider);
  }
});

test("a session on this Mac has no Desktop tab, whatever its provider says", () => {
  assert.deepEqual(ids("daytona", true), ["environment", "changes"]);
});

test("a mission's pane is its Ships, without tabs", () => {
  assert.deepEqual(ids("daytona", false, "mission"), []);
});

test("the tab shown is the one chosen while the pane has it, else its first", () => {
  const cloud = inspectorTabs({ provider: "daytona" }, false);
  assert.equal(shownTab(cloud, "desktop"), "desktop");
  assert.equal(shownTab(cloud, "environment"), "environment");
  const local = inspectorTabs({ provider: "daytona" }, true);
  assert.equal(shownTab(local, "desktop"), "environment");
  assert.equal(shownTab([], "desktop"), null);
});
