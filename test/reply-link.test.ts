import assert from "node:assert/strict";
import { test } from "node:test";

import { previewPage, replyLink } from "@/lib/session/reply-link";

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

test("a link to the box's own localhost opens that page through the port's preview", () => {
  assert.deepEqual(replyLink("http://localhost:3210/outrunner-slack-icon.png", "ws-1"), {
    kind: "box-server",
    workspaceId: "ws-1",
    port: 3210,
    page: "/outrunner-slack-icon.png",
  });
  assert.deepEqual(replyLink("http://127.0.0.1:5173/?q=1#top", "ws-1"), { kind: "box-server", workspaceId: "ws-1", port: 5173, page: "/?q=1#top" });
  assert.deepEqual(replyLink("http://0.0.0.0:8000", "ws-1"), { kind: "box-server", workspaceId: "ws-1", port: 8000, page: "/" });
  assert.deepEqual(replyLink("http://[::1]/", "ws-1"), { kind: "box-server", workspaceId: "ws-1", port: 80, page: "/" });
  // On this Mac, localhost is the user's own: as written.
  assert.deepEqual(replyLink("http://localhost:3000/", null), { kind: "as-written" });
  assert.deepEqual(replyLink("http://localhost.example.com:3000/", "ws-1"), { kind: "as-written" });
});

test("the page lands on the preview's host, keeping the preview's own path and query", () => {
  assert.equal(previewPage("https://3210-tok.proxy.daytona.works", "/a b.png?x=1#f"), "https://3210-tok.proxy.daytona.works/a%20b.png?x=1#f");
  assert.equal(previewPage("https://proxy.example/p/3210/?token=s", "/app?x=1"), "https://proxy.example/p/3210/app?token=s&x=1");
  assert.equal(previewPage("https://3210-tok.proxy.daytona.works/", "/"), "https://3210-tok.proxy.daytona.works/");
});
