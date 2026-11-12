import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { FrameBoundary, keepPreviewSocketAlive, PING_FRAME } from "@/lib/previews/ws-keepalive";

/** A server's unmasked frame header for a payload of `length` bytes. */
function header(length: number, opcode = 0x1): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 65536) return Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  const out = Buffer.alloc(10);
  out[0] = 0x80 | opcode;
  out[1] = 127;
  out.writeBigUInt64BE(BigInt(length), 2);
  return out;
}

test("frame boundaries are followed across chunks and every length form", () => {
  const frames = new FrameBoundary();
  assert.equal(frames.atBoundary(), true);
  for (const length of [0, 5, 125, 126, 300, 65535, 70_000]) {
    const frame = Buffer.concat([header(length), Buffer.alloc(length, 0x61)]);
    // Split everywhere a proxy might: inside the header, inside the payload.
    for (const cut of [1, 2, Math.min(3, frame.length), Math.floor(frame.length / 2)]) {
      frames.feed(frame.subarray(0, cut));
      if (cut < frame.length) assert.equal(frames.atBoundary(), false, `length ${length}, cut ${cut}`);
      frames.feed(frame.subarray(cut));
      assert.equal(frames.atBoundary(), true, `length ${length}, cut ${cut}`);
    }
  }
  // A masked frame (a client's) has its 4 key bytes after the length.
  frames.feed(Buffer.from([0x81, 0x80 | 3, 1, 2, 3, 4]));
  assert.equal(frames.atBoundary(), false);
  frames.feed(Buffer.from([9, 9, 9]));
  assert.equal(frames.atBoundary(), true);
});

test("a quiet preview socket gets pings, never in the middle of the box's frame", async () => {
  const browser = new PassThrough();
  const fromBox = new PassThrough();
  const sent: Buffer[] = [];
  browser.on("data", (chunk: Buffer) => sent.push(chunk));
  fromBox.pipe(browser);
  keepPreviewSocketAlive(browser, fromBox, Buffer.alloc(0), 10);

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(sent.filter((chunk) => chunk.equals(PING_FRAME)).length >= 2, "pinged while idle");

  // Half a frame from the box: no ping until it's done.
  sent.length = 0;
  fromBox.write(Buffer.concat([header(10), Buffer.from("hello")]));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(sent.filter((chunk) => chunk.equals(PING_FRAME)).length, 0);
  fromBox.write(Buffer.from("world"));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(sent.some((chunk) => chunk.equals(PING_FRAME)));

  fromBox.destroy();
  browser.destroy();
});
