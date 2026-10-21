import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ImportCapture, ImportCaptureSkip, ImportScan } from "@/lib/runtime/import-scan";

/** The examples runtime-agent's Go types are checked against too. */
const fixtures = JSON.parse(
  readFileSync(path.join(process.cwd(), "lib/runtime/import-scan.fixtures.json"), "utf8"),
) as Record<string, unknown[]>;

test("the shared scan and capture examples parse, and parse back the same", () => {
  const schemas = { Scan: ImportScan, Capture: ImportCapture, CaptureSkip: ImportCaptureSkip };
  assert.deepEqual(Object.keys(fixtures).sort(), Object.keys(schemas).sort());
  for (const [group, schema] of Object.entries(schemas)) {
    for (const example of fixtures[group]) {
      assert.deepEqual(schema.parse(example), example, group);
    }
  }
});
