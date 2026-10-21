import assert from "node:assert/strict";
import { test } from "node:test";

import { getStartedSteps, showGetStarted } from "@/lib/nav/get-started";

test("each step is ticked off by what the app knows", () => {
  const done = (signals: Parameters<typeof getStartedSteps>[0]) =>
    getStartedSteps(signals).map((s) => [s.id, s.done]);
  assert.deepEqual(done({ projects: 0, sessions: 0, claudeConnected: false }), [
    ["project", false],
    ["session", false],
    ["claude", false],
  ]);
  assert.deepEqual(done({ projects: 2, sessions: 1, claudeConnected: true }), [
    ["project", true],
    ["session", true],
    ["claude", true],
  ]);
  // Still checking Claude: not ticked, and not said to be undone either.
  assert.equal(getStartedSteps({ projects: 1, sessions: 1, claudeConnected: null })[2].done, null);
});

test("Claude's step opens its subscription card in Settings → Providers", () => {
  const claude = getStartedSteps({ projects: 0, sessions: 0, claudeConnected: false })[2];
  assert.equal(claude.href, "/settings/providers?tab=claude&method=subscription");
});

test("the checklist shows until it's done or skipped", () => {
  const some = getStartedSteps({ projects: 1, sessions: 0, claudeConnected: false });
  const all = getStartedSteps({ projects: 1, sessions: 1, claudeConnected: true });
  assert.equal(showGetStarted(some, false), true);
  assert.equal(showGetStarted(some, true), false);
  assert.equal(showGetStarted(all, false), false);
});

test("nothing shows while a step is still unknown, however the rest stand", () => {
  // The user has done everything, but Claude hasn't been checked: showing the
  // checklist here would say 2/3 and then vanish as the answer lands.
  const checking = getStartedSteps({ projects: 1, sessions: 1, claudeConnected: null });
  assert.equal(showGetStarted(checking, false), false);
  // It waits even where the answer cannot change the outcome: the count would
  // tick up on screen instead, and one rule is easier to hold than two.
  const starting = getStartedSteps({ projects: 0, sessions: 0, claudeConnected: null });
  assert.equal(showGetStarted(starting, false), false);
  assert.equal(showGetStarted(getStartedSteps({ projects: 0, sessions: 0, claudeConnected: false }), false), true);
});
