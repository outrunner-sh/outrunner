import assert from "node:assert/strict";
import { test } from "node:test";

import { canvasFileError, canvasPathFrom, canvasPathIn, VISUAL_EMBED_SCRIPT, VISUAL_HEIGHT_MESSAGE, visualHeight } from "@/lib/session/canvas";

test("a reply's image is the Canvas's when it names a file in the session's own Canvas", () => {
  assert.equal(canvasPathIn("/home/runtime/.outrunner/canvas/ws-1/latency.html", "ws-1"), "latency.html");
  assert.equal(canvasPathIn("~/.outrunner/canvas/ws-1/charts/./p95.png", "ws-1"), "charts/p95.png");
  assert.equal(canvasPathIn("/home/runtime/.outrunner/canvas/ws-2/latency.html", "ws-1"), null);
  assert.equal(canvasPathIn("/home/runtime/.outrunner/canvas/ws-1/../ws-2/x.html", "ws-1"), null);
  assert.equal(canvasPathIn(".context/screenshot.png", "ws-1"), null);
  assert.equal(canvasPathIn("/home/runtime/.outrunner/canvas/ws-1/", "ws-1"), null);
});

test("a Canvas file's images are named from its own folder, and never out of the Canvas", () => {
  assert.equal(canvasPathFrom("reports/q3.md", "charts/p95.png"), "reports/charts/p95.png");
  assert.equal(canvasPathFrom("plan.md", "./flow.svg"), "flow.svg");
  assert.equal(canvasPathFrom("reports/q3.md", "../plan.png"), null);
  assert.equal(canvasPathFrom("plan.md", "/etc/passwd"), null);
  assert.equal(canvasPathFrom("plan.md", "~/x.png"), null);
});

test("a visual says its height, and its frame keeps to bounds", () => {
  assert.match(VISUAL_EMBED_SCRIPT, new RegExp(`^<script>.*${VISUAL_HEIGHT_MESSAGE}.*</script>$`, "s"));
  // The injected browser program parses independently of the app bundle.
  assert.doesNotThrow(() => new Function(VISUAL_EMBED_SCRIPT.replace(/^<script>|<\/script>$/g, "")));
  assert.match(VISUAL_EMBED_SCRIPT, /selectNodeContents/);
  assert.doesNotMatch(VISUAL_EMBED_SCRIPT, /scrollHeight/);
  assert.equal(visualHeight(512.4), 512);
  assert.equal(visualHeight(5), 80);
  assert.equal(visualHeight(100_000), 900);
  assert.equal(visualHeight("700"), 360);
  assert.equal(visualHeight(Number.NaN), 360);
});

test("inline page failures keep the route's reason", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const status = Number(url);
    return new Response(JSON.stringify({ error: `Route error ${status}` }), { status });
  });
  for (const status of [404, 413, 502]) {
    assert.equal(await canvasFileError(String(status)), `Route error ${status}`);
  }
});

test("inline page preflight cancels successful bodies and handles non-JSON errors", async (t) => {
  let canceled = false;
  t.mock.method(globalThis, "fetch", async (url: string) => url === "ok"
    ? new Response(new ReadableStream({ cancel() { canceled = true; } }))
    : new Response("Bad gateway", { status: 502 }));
  assert.equal(await canvasFileError("ok"), null);
  assert.equal(canceled, true);
  assert.equal(await canvasFileError("bad"), "Couldn't read that file (502).");
});
