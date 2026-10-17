import assert from "node:assert/strict";
import { test } from "node:test";

import { BOX_SIZES, boxSize, DEFAULT_BOX_SIZE, isBoxSizeId } from "@/lib/runtime/box-sizes";
import { neevResources } from "@/lib/runtime/sandbox/neev";

test("sandboxes come in X Small to Large, smallest first, Small by default", () => {
  assert.deepEqual(
    BOX_SIZES.map((s) => `${s.label} ${s.cpu}/${s.memoryGb}`),
    ["X Small 1/2", "Small 2/4", "Medium 4/8", "Large 8/16"],
  );
  assert.equal(DEFAULT_BOX_SIZE, "small");
});

test("every size fits what Neev can make (0.5 to 8 vCPU in halves, 1 to 16 GB)", () => {
  for (const size of BOX_SIZES) {
    assert.ok(size.cpu >= 0.5 && size.cpu <= 8 && Number.isInteger(size.cpu * 2), size.id);
    assert.ok(size.memoryGb >= 1 && size.memoryGb <= 16, size.id);
  }
});

test("an unknown size id is refused, and read back as the default", () => {
  assert.equal(isBoxSizeId("medium"), true);
  assert.equal(isBoxSizeId("huge"), false);
  assert.equal(isBoxSizeId(undefined), false);
  assert.equal(boxSize("huge").id, DEFAULT_BOX_SIZE);
});

test("a size goes to Neev as its cpu and memory_gb", () => {
  assert.deepEqual(neevResources(boxSize("medium")), { cpu: 4, memory_gb: 8 });
});
