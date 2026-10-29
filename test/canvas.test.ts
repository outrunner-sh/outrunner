import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANVAS_HTML_CSP,
  CANVAS_INERT_CSP,
  canvasFileUrl,
  canvasKind,
  formatSize,
  hasSource,
  MAX_CSV_COLUMNS,
  parseCsv,
} from "@/lib/session/canvas";

test("a Canvas file is what its name says", () => {
  assert.equal(canvasKind("rollout-plan.md"), "markdown");
  assert.equal(canvasKind("reports/Latency.HTML"), "html");
  assert.equal(canvasKind("flow.mmd"), "mermaid");
  assert.equal(canvasKind("results.csv"), "csv");
  assert.equal(canvasKind("shot.PNG"), "image");
  assert.equal(canvasKind("logo.svg"), "svg");
  assert.equal(canvasKind("notes.json"), "text");
  assert.equal(canvasKind("archive.zip"), "other");
  assert.equal(canvasKind(".env"), "other");
  assert.equal(canvasKind("Makefile"), "other");
  assert.ok(hasSource("html") && !hasSource("image"));
});

test("a CSV is read as RFC 4180 has it", () => {
  assert.deepEqual(parseCsv('﻿name,score\r\n"Ada, Countess",3\n"say ""hi""","two\nlines"\n').rows, [
    ["name", "score"],
    ["Ada, Countess", "3"],
    ['say "hi"', "two\nlines"],
  ]);
  assert.deepEqual(parseCsv("a,b\n1,").rows, [["a", "b"], ["1", ""]]);
  assert.deepEqual(parseCsv("").rows, []);
  const long = parseCsv("h\n1\n2\n3\n4\n", 3);
  assert.deepEqual(long.rows, [["h"], ["1"], ["2"]]);
  assert.equal(long.truncated, true);
  assert.equal(parseCsv("h\n1\n2\n", 3).truncated, false);
  assert.equal(parseCsv(`${Array.from({ length: 80 }, (_, i) => i).join(",")}\n`).rows[0].length, MAX_CSV_COLUMNS);
});

test("a page runs sandboxed in an origin of its own, and anything else is inert", () => {
  assert.match(CANVAS_HTML_CSP, /^sandbox allow-scripts/);
  assert.doesNotMatch(CANVAS_HTML_CSP, /allow-same-origin/);
  assert.match(CANVAS_HTML_CSP, /default-src 'none'/);
  assert.doesNotMatch(CANVAS_HTML_CSP, /connect-src/); // falls back to none
  assert.match(CANVAS_INERT_CSP, /sandbox$/);
  assert.doesNotMatch(CANVAS_INERT_CSP, /script-src/);
});

test("sizes and URLs read as the panel shows them", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2.0 KB");
  assert.equal(formatSize(20 * 1024), "20 KB");
  assert.equal(formatSize(3.5 * 1024 * 1024), "3.5 MB");
  assert.equal(canvasFileUrl("ws-1", "charts/a b.html"), "/api/workspaces/ws-1/canvas/file?path=charts%2Fa%20b.html");
});
