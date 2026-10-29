import assert from "node:assert/strict";
import { test } from "node:test";

import { parseReadyBody, readyNotification } from "@/lib/missions/events";
import { DEFAULT_PREFERENCES, KIND_LABEL, missionsQuiet, NOTIFICATION_KINDS } from "@/lib/notifications/events";
import { instantEmail, slackMessage } from "@/lib/notifications/messages";

test("a Runner's own news is its Mission's, never the user's", () => {
  for (const kind of NOTIFICATION_KINDS) assert.equal(missionsQuiet(kind, { kind: "session", parentMissionId: "m1" }), true, kind);
});

test("a Mission tells the user what needs them, not its every turn", () => {
  const mission = { kind: "mission" as const, parentMissionId: null };
  assert.equal(missionsQuiet("needs_input", mission), false);
  assert.equal(missionsQuiet("errored", mission), false);
  assert.equal(missionsQuiet("pr_ready", mission), false);
  assert.equal(missionsQuiet("turn_done", mission), true);
  // Any other session is told as before.
  for (const kind of NOTIFICATION_KINDS) assert.equal(missionsQuiet(kind, { kind: "session", parentMissionId: null }), false, kind);
});

test("a pull request ready is a kind of its own, on by default, worded for each way it goes", () => {
  assert.ok(DEFAULT_PREFERENCES.kinds.includes("pr_ready"));
  assert.equal(KIND_LABEL.pr_ready, "A Ship's pull request is ready to review");
  const draft = readyNotification({
    ownerId: "u1",
    missionId: "m1",
    missionTitle: "Billing",
    runnerName: "runner-c",
    runnerId: "r1",
    pr: { repo: "Acme/App", number: 270, url: "https://github.com/acme/app/pull/270", title: "Fix proration" },
    seq: 1,
  });
  assert.deepEqual(draft, {
    userId: "u1",
    workspaceId: "m1",
    kind: "pr_ready",
    eventKey: "r1:acme/app#270:1",
    title: "Billing",
    body: "#270 ready to review: Fix proration (runner-c)",
  });
  const sent = { workspaceId: "m1", kind: "pr_ready" as const, title: draft.title, body: draft.body, createdAt: "2026-11-03T10:00:00Z" };
  assert.equal(instantEmail(sent, "https://app.outrunner.sh").subject, "Ready to review: Billing");
  assert.match(slackMessage(sent, "https://app.outrunner.sh"), /^:eyes: \*<https:\/\/app\.outrunner\.sh\/workspaces\/m1\|Billing>\*/);
});

test("the toast reads back what readyNotification wrote, titles with brackets too", () => {
  const body = (title: string) =>
    readyNotification({
      ownerId: "u1",
      missionId: "m1",
      missionTitle: "Billing",
      runnerName: "runner-c",
      runnerId: "r1",
      pr: { repo: "acme/app", number: 270, url: "https://github.com/acme/app/pull/270", title },
      seq: 1,
    }).body;
  assert.deepEqual(parseReadyBody(body("Fix proration")), { number: 270, title: "Fix proration", runner: "runner-c" });
  assert.deepEqual(parseReadyBody(body("Fix (some) proration")), { number: 270, title: "Fix (some) proration", runner: "runner-c" });
  assert.equal(parseReadyBody("Billing is waiting on you"), null);
});
