import assert from "node:assert/strict";
import { test } from "node:test";

import { readCappedBody } from "@/lib/http/capped-body";

/** A request whose body arrives in chunks, as a chunked upload does — so the
 *  stream path is exercised rather than the content-length shortcut. */
function streamed(chunks: number, size = 600) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(size));
      if (pulled === chunks) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  // `duplex` is Node's, not the DOM's, so the DOM types don't know it.
  const request = new Request("https://outrunner.test/api/client-errors", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  return { request, read: () => pulled, cancelled: () => cancelled };
}

test("a body within the cap comes back as its text", async () => {
  const request = new Request("https://outrunner.test/x", { method: "POST", body: '{"a":1}' });
  assert.equal(await readCappedBody(request, 8 * 1024), '{"a":1}');
});

test("a request with no body reads as empty", async () => {
  assert.equal(await readCappedBody(new Request("https://outrunner.test/x"), 8 * 1024), "");
});

test("a declared body past the cap is refused without being read", async () => {
  const { request, read } = streamed(20);
  request.headers.set("content-length", String(50 * 1024 * 1024));
  // The stream prefills one chunk by itself, and with the queue full it cannot
  // pull another until something reads. Let that settle, then check the read
  // never starts: the count is unchanged.
  await new Promise((settle) => setTimeout(settle, 0));
  const before = read();
  assert.equal(await readCappedBody(request, 8 * 1024), null);
  assert.equal(read(), before, "the body was read despite the declared length");
});

test("a chunked body past the cap stops the read there", async () => {
  // No content-length: the count itself is the bound. Twenty chunks of 600
  // bytes pass an 8 KiB cap on the fifteenth.
  const { request, read, cancelled } = streamed(20);
  assert.equal(await readCappedBody(request, 8 * 1024), null);
  assert.equal(cancelled(), true, "the reader was left to drain the rest");
  assert.ok(read() < 20, `read all ${read()} chunks past the cap`);
});

test("a chunked body exactly at the cap is kept", async () => {
  const { request } = streamed(4, 512); // 2048 bytes, the cap itself
  const text = await readCappedBody(request, 2048);
  assert.equal(text?.length, 2048);
});
