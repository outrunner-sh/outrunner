import assert from "node:assert/strict";
import { test } from "node:test";

import { digestEmail, instantEmail, slackMessage, type SentNotification } from "@/lib/notifications/messages";
import { rememberShown, shouldShow } from "@/lib/notifications/show";

const base = "https://app.outrunner.sh";
const n = (patch: Partial<SentNotification>): SentNotification => ({
  workspaceId: "w1",
  kind: "turn_done",
  title: "Fix login",
  body: "Fixed it.",
  createdAt: "2026-10-28T10:00:00Z",
  ...patch,
});

test("an instant email names what happened and links the session and settings", () => {
  const email = instantEmail(n({ kind: "needs_input", body: "Asked you a question" }), base);
  assert.equal(email.subject, "Needs you: Fix login");
  assert.match(email.text, /Asked you a question/);
  assert.match(email.text, /https:\/\/app\.outrunner\.sh\/workspaces\/w1/);
  assert.match(email.text, /\/settings\/account/);
});

test("a digest groups by session, newest first, and counts what waits on you", () => {
  const email = digestEmail(
    [
      n({ createdAt: "2026-10-28T09:00:00Z" }),
      n({ workspaceId: "w2", title: "Bump deps", kind: "errored", body: "Errored", createdAt: "2026-10-28T11:00:00Z" }),
      n({ kind: "pr_merged", body: "Pull request #4 merged", createdAt: "2026-10-28T10:30:00Z" }),
    ],
    base,
  );
  assert.equal(email.subject, "Your sessions today: 2 with news, 1 waiting on you");
  assert.ok(email.text.indexOf("Bump deps") < email.text.indexOf("Fix login"));
  assert.ok(email.text.indexOf("#4 merged") < email.text.indexOf("Fixed it."));
});

test("a Slack DM links the session, its title escaped", () => {
  assert.equal(
    slackMessage(n({ title: "a <b> & c", kind: "pr_merged", body: "Pull request #4 merged" }), base),
    ":tada: *<https://app.outrunner.sh/workspaces/w1|a &lt;b&gt; &amp; c>*\nPull request #4 merged",
  );
});

test("the session on screen in a window in front isn't told; any other is", () => {
  const here = { workspaceId: "w1" };
  assert.equal(shouldShow(here, { browserOn: true, onScreen: "w1", looking: true }), false);
  assert.equal(shouldShow(here, { browserOn: true, onScreen: "w1", looking: false }), true, "a tab in the background");
  assert.equal(shouldShow(here, { browserOn: true, onScreen: "w2", looking: true }), true);
  assert.equal(shouldShow(here, { browserOn: false, onScreen: undefined, looking: false }), false);
});

test("shown ids are kept once each, the newest few", () => {
  assert.deepEqual(rememberShown(["a", "b"], "a"), ["b", "a"]);
  assert.deepEqual(rememberShown(["a", "b", "c"], "d", 3), ["b", "c", "d"]);
});
