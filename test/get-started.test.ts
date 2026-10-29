import assert from "node:assert/strict";
import { test } from "node:test";

import { getStartedSteps, showGetStarted } from "@/lib/nav/get-started";

test("each step is ticked off by what the app knows", () => {
  const done = (signals: Parameters<typeof getStartedSteps>[0]) =>
    getStartedSteps(signals).map((s) => [s.id, s.done]);
  assert.deepEqual(done({ projects: 0, sessions: 0, claudeConnected: false, startsWithoutClaude: false }), [
    ["project", false],
    ["session", false],
    ["claude", false],
  ]);
  assert.deepEqual(done({ projects: 2, sessions: 1, claudeConnected: true, startsWithoutClaude: false }), [
    ["project", true],
    ["session", true],
    ["claude", true],
  ]);
  // Still checking Claude: not ticked, and not said to be undone either.
  assert.equal(getStartedSteps({ projects: 1, sessions: 1, claudeConnected: null, startsWithoutClaude: false })[2].done, null);
});

test("the project step opens the repository picker, the session step the composer", () => {
  const [project, session] = getStartedSteps({ projects: 0, sessions: 0, claudeConnected: false, startsWithoutClaude: false });
  assert.equal(project.href, "/new?pick=repo");
  assert.equal(session.href, "/new?focus=composer");
});

test("Claude's step opens its subscription card in Personal → Coding agents", () => {
  const claude = getStartedSteps({ projects: 0, sessions: 0, claudeConnected: false, startsWithoutClaude: false })[2];
  assert.equal(claude.href, "/settings/coding-agents?tab=claude&method=subscription");
});

test("the checklist shows until it's done or skipped", () => {
  const some = getStartedSteps({ projects: 1, sessions: 0, claudeConnected: false, startsWithoutClaude: false });
  const all = getStartedSteps({ projects: 1, sessions: 1, claudeConnected: true, startsWithoutClaude: false });
  assert.equal(showGetStarted(some, false), true);
  assert.equal(showGetStarted(some, true), false);
  assert.equal(showGetStarted(all, false), false);
});

test("nothing shows while a step is still unknown, however the rest stand", () => {
  // The user has done everything, but Claude hasn't been checked: showing the
  // checklist here would say 2/3 and then vanish as the answer lands.
  const checking = getStartedSteps({ projects: 1, sessions: 1, claudeConnected: null, startsWithoutClaude: false });
  assert.equal(showGetStarted(checking, false), false);
  // It waits even where the answer cannot change the outcome: the count would
  // tick up on screen instead, and one rule is easier to hold than two.
  const starting = getStartedSteps({ projects: 0, sessions: 0, claudeConnected: null, startsWithoutClaude: false });
  assert.equal(showGetStarted(starting, false), false);
  assert.equal(showGetStarted(getStartedSteps({ projects: 0, sessions: 0, claudeConnected: false, startsWithoutClaude: false }), false), true);
});

test("where sessions start without Claude, connecting it isn't a step", () => {
  const ids = (startsWithoutClaude: boolean | null) =>
    getStartedSteps({ projects: 1, sessions: 0, claudeConnected: false, startsWithoutClaude }).map((s) => s.id);
  assert.deepEqual(ids(true), ["project", "session"]);
  assert.deepEqual(ids(false), ["project", "session", "claude"]);
  // A first session on Outrunner's models finishes the checklist.
  const started = getStartedSteps({ projects: 1, sessions: 1, claudeConnected: false, startsWithoutClaude: true });
  assert.equal(showGetStarted(started, false), false);
});

test("until the menu says whether Claude is needed, the checklist waits", () => {
  const unknown = getStartedSteps({ projects: 1, sessions: 0, claudeConnected: false, startsWithoutClaude: null });
  assert.equal(unknown.find((s) => s.id === "claude")?.done, null);
  assert.equal(showGetStarted(unknown, false), false);
});
