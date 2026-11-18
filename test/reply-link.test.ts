import assert from "node:assert/strict";
import { test } from "node:test";

import { replyLink } from "@/lib/session/reply-link";

test("a path in a cloud session's reply downloads the file off its box", () => {
  for (const [href, path] of [
    ["outrunner-slack-icon.png", "outrunner-slack-icon.png"],
    ["/home/runtime/Downloads/outrunner-slack-icon.png", "/home/runtime/Downloads/outrunner-slack-icon.png"],
    ["~/Downloads/icons%20v2.zip", "~/Downloads/icons v2.zip"],
    ["file:///tmp/report.pdf", "/tmp/report.pdf"],
    ["src/app.ts#L42", "src/app.ts"],
  ]) {
    assert.deepEqual(replyLink(href, "ws-1"), { kind: "box-file", workspaceId: "ws-1", path }, href);
  }
});

test("a Canvas file opens in the Canvas, not as a download", () => {
  assert.deepEqual(replyLink("/home/runtime/.outrunner/canvas/ws-1/plan.md", "ws-1"), {
    kind: "canvas",
    workspaceId: "ws-1",
    path: "plan.md",
  });
  // A document's own relative links are its Canvas's.
  assert.deepEqual(replyLink("chart.png", null, { workspaceId: "ws-1", path: "reports/index.md" }), {
    kind: "canvas",
    workspaceId: "ws-1",
    path: "reports/chart.png",
  });
});

test("a path with no box to read it from isn't followed", () => {
  assert.deepEqual(replyLink("outrunner-slack-icon.png", null), { kind: "no-box", path: "outrunner-slack-icon.png" });
});

test("web pages, mail and anchors stay as written", () => {
  for (const href of ["https://github.com/o/r/pull/1", "mailto:a@b.co", "#summary", "?tab=2", "", undefined]) {
    assert.deepEqual(replyLink(href, "ws-1"), { kind: "as-written" }, String(href));
  }
});
