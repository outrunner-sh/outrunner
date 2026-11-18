import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInfo } from "@/lib/observability/build";

// The deploy checks a server is the commit it deployed, running the tree it
// tested: both come from the environment, the tree baked into the image.
test("a server says which commit it's deployed as and which tree it runs", () => {
  assert.deepEqual(buildInfo({ OUTRUNNER_BUILD: "a".repeat(40), OUTRUNNER_TREE: "b".repeat(40) }), { build: "a".repeat(40), tree: "b".repeat(40) });
  // Unset or empty (an image built without them): unknown, never "".
  assert.deepEqual(buildInfo({ OUTRUNNER_BUILD: "", OUTRUNNER_TREE: undefined }), { build: null, tree: null });
});
