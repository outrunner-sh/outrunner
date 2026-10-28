import assert from "node:assert/strict";
import { test } from "node:test";

import { pullRequestEventOf, stateOf } from "@/lib/session/pull-request-event";

const payload = (action: string, pr: Record<string, unknown> = {}) => ({
  action,
  repository: { full_name: "acme/api" },
  pull_request: { number: 7, html_url: "https://github.com/acme/api/pull/7", title: "Fix", state: "open", head: { ref: "runtime/x" }, base: { ref: "main" }, ...pr },
});

test("GitHub's pull request reads as open, closed or merged", () => {
  assert.equal(stateOf({ state: "open" }), "open");
  assert.equal(stateOf({ state: "closed", merged: false }), "closed");
  assert.equal(stateOf({ state: "closed", merged: true }), "merged");
  assert.equal(stateOf({ state: "closed", merged_at: "2026-10-28T10:00:00Z" }), "merged");
  assert.equal(stateOf({ state: "weird" }), null);
});

test("opening, reopening and closing are recorded; labels and reviews aren't", () => {
  assert.equal(pullRequestEventOf(payload("opened"))?.state, "open");
  assert.equal(pullRequestEventOf(payload("closed", { state: "closed", merged: true }))?.state, "merged");
  assert.equal(pullRequestEventOf(payload("reopened"))?.headRef, "runtime/x");
  assert.equal(pullRequestEventOf(payload("labeled")), null);
  assert.equal(pullRequestEventOf({ action: "opened", repository: { full_name: "acme/api" } }), null);
});
