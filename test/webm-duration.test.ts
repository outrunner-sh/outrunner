import assert from "node:assert/strict";
import { test } from "node:test";

import { webmWithDuration } from "@/lib/session/webm-duration";

/** An EBML element: its ID bytes, a size (one byte, or eight as the patch
 *  writes it), its data. */
function el(id: number[], data: Uint8Array | number[], wide = false): Uint8Array {
  const body = Uint8Array.from(data);
  const size = wide
    ? [0x01, 0, 0, 0, 0, 0, 0, body.length]
    : [0x80 | body.length];
  return Uint8Array.from([...id, ...size, ...body]);
}
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const float64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return b;
};

const EBML_HEADER = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [...new TextEncoder().encode("webm")]));
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const SCALE = el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]); // 1,000,000
const MUXER = el([0x4d, 0x80], [...new TextEncoder().encode("Chrome")]);
const TRACKS = el([0x16, 0x54, 0xae, 0x6b], [0xae, 0x80]);
const CLUSTER = Uint8Array.from([0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN_SIZE, 0xe7, 0x81, 0x00]);
const INFO = [0x15, 0x49, 0xa9, 0x66];

/** A recorded WebM as Chrome writes it: a streamed Segment, Info without a
 *  Duration, then Tracks and Clusters. */
const chrome = cat(EBML_HEADER, Uint8Array.from([...SEGMENT_ID, ...UNKNOWN_SIZE]), el(INFO, cat(SCALE, MUXER)), TRACKS, CLUSTER);

function patched(bytes: Uint8Array, ms: number): Uint8Array {
  const result = webmWithDuration(bytes, ms);
  assert.ok(result);
  return cat(result.head, bytes.subarray(result.consumed));
}

test("a Duration is added to Info, and everything after it is unchanged", () => {
  const out = patched(chrome, 14_150);
  const info = el(INFO, cat(SCALE, MUXER, el([0x44, 0x89], float64(14_150))), true);
  assert.deepEqual(out, cat(EBML_HEADER, Uint8Array.from([...SEGMENT_ID, ...UNKNOWN_SIZE]), info, TRACKS, CLUSTER));
});

test("the Duration is in TimecodeScale units", () => {
  const scaled = cat(
    EBML_HEADER,
    Uint8Array.from([...SEGMENT_ID, ...UNKNOWN_SIZE]),
    el(INFO, cat(el([0x2a, 0xd7, 0xb1], [0x98, 0x96, 0x80]), MUXER)), // 10,000,000 ns
    TRACKS,
  );
  const out = patched(scaled, 2_000);
  const at = out.findIndex((b, i) => b === 0x44 && out[i + 1] === 0x89 && out[i + 2] === 0x88);
  assert.equal(new DataView(out.buffer, at + 3, 8).getFloat64(0), 200);
});

test("a Duration already there is overwritten in place", () => {
  const withZero = cat(
    EBML_HEADER,
    Uint8Array.from([...SEGMENT_ID, ...UNKNOWN_SIZE]),
    el(INFO, cat(SCALE, el([0x44, 0x89], float64(0)))),
    TRACKS,
  );
  const out = patched(withZero, 5_000);
  assert.equal(out.length, withZero.length);
  const at = out.findIndex((b, i) => b === 0x44 && out[i + 1] === 0x89);
  assert.equal(new DataView(out.buffer, at + 3, 8).getFloat64(0), 5_000);
});

test("a Segment of known size grows by what Info grew", () => {
  const info = el(INFO, cat(SCALE, MUXER));
  const body = cat(info, TRACKS);
  const known = cat(EBML_HEADER, Uint8Array.from([...SEGMENT_ID, 0x40, body.length]), body);
  const out = patched(known, 1_000);
  const sizeAt = EBML_HEADER.length + 4;
  const grownInfo = el(INFO, cat(SCALE, MUXER, el([0x44, 0x89], float64(1_000))), true);
  assert.equal(((out[sizeAt] & 0x3f) << 8) | out[sizeAt + 1], grownInfo.length + TRACKS.length);
});

test("what it can't patch safely is left alone", () => {
  // Not a WebM.
  assert.equal(webmWithDuration(Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), 1_000), null);
  // A SeekHead before Info: its positions would move.
  const seekFirst = cat(
    EBML_HEADER,
    Uint8Array.from([...SEGMENT_ID, ...UNKNOWN_SIZE]),
    el([0x11, 0x4d, 0x9b, 0x74], [0xec, 0x80]),
    el(INFO, cat(SCALE, MUXER)),
  );
  assert.equal(webmWithDuration(seekFirst, 1_000), null);
  // Cut off before Info ends, or no length to give it.
  assert.equal(webmWithDuration(chrome.subarray(0, 30), 1_000), null);
  assert.equal(webmWithDuration(chrome, 0), null);
});
