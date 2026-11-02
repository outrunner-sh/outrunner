import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasLinkPath } from "@/lib/session/canvas-link";

test("Full proposal links resolve to the session's Canvas file", () => {
  for (const prefix of ["/home/runtime", "~", "file:///home/runtime"]) {
    assert.equal(canvasLinkPath(`${prefix}/.outrunner/canvas/ws-1/full%20proposal.md`, "ws-1"), "full proposal.md");
  }
  assert.equal(canvasLinkPath("proposal.md", "ws-1", "reports/index.md"), "reports/proposal.md");
});

test("ordinary links and files outside this Canvas keep their navigation", () => {
  for (const href of ["https://example.com/plan", "#summary", "/etc/passwd", "/home/runtime/.outrunner/canvas/ws-2/plan.md", "/home/runtime/.outrunner/canvas/ws-1/../secret"]) {
    assert.equal(canvasLinkPath(href, "ws-1"), null);
  }
  assert.equal(canvasLinkPath("proposal.md", null), null);
});
