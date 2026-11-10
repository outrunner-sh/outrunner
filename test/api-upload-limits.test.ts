import assert from "node:assert/strict";
import { test } from "node:test";

import { UNSENT_MAX, uploadSizeRefusal } from "@/lib/api/upload-limits";
import { MAX_ATTACHMENT_BYTES } from "@/lib/runtime/attachments";

test("an upload is refused before it's read when it's too big or unsized", () => {
  assert.equal(uploadSizeRefusal(String(1024)), null);
  assert.equal(uploadSizeRefusal(String(MAX_ATTACHMENT_BYTES + 1024)), null);
  assert.equal(uploadSizeRefusal(String(MAX_ATTACHMENT_BYTES * 2))?.status, 413);
  assert.equal(uploadSizeRefusal(null)?.status, 411);
  assert.equal(uploadSizeRefusal("-5")?.status, 411);
});

test("unsent uploads are capped per day", () => {
  assert.ok(UNSENT_MAX.count > 10 && UNSENT_MAX.bytes >= 10 * MAX_ATTACHMENT_BYTES);
});
