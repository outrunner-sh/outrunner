/**
 * A duration for a WebM that MediaRecorder wrote without one (Chrome's never
 * has it: it can't know the length while it streams), so players show the
 * recording's length and a seek bar. Only the Segment's Info is rewritten, in
 * the file's first bytes; the frames after it are left as they are.
 *
 * WebM is EBML: each element an ID, a size and its data, the IDs and sizes
 * variable-length integers. https://www.matroska.org/technical/elements.html
 */

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const VOID = 0xec;

/** How much of the file to read for the patch: Info comes in the first few
 *  hundred bytes of a recorded WebM. */
export const WEBM_HEAD_BYTES = 64 * 1024;

type Vint = { value: number; length: number; unknown: boolean };

/** An element ID at `at`, kept with its marker bits as IDs are written. */
function readId(bytes: Uint8Array, at: number): Vint | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 4 || at + length > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[at + i];
  return { value, length, unknown: false };
}

/** An element's size at `at`; `unknown` for the all-ones size a streaming
 *  writer leaves on the Segment and its Clusters. */
function readSize(bytes: Uint8Array, at: number): Vint | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let ones = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    ones &&= bytes[at + i] === 0xff;
  }
  return { value, length, unknown: ones };
}

/** `value` as an EBML size in `length` bytes, or null if it doesn't fit. */
function writeSize(value: number, length: number): Uint8Array | null {
  if (length < 1 || length > 8 || value >= 2 ** (7 * length) - 1) return null;
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function readUint(bytes: Uint8Array, at: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[at + i];
  return value;
}

/**
 * The file's first `consumed` bytes, rewritten as `head` with a Duration of
 * `durationMs` in the Segment's Info; or null when it isn't a WebM this can
 * patch safely: Info must be the Segment's first element (after any Void),
 * as MediaRecorder writes it, since growing it moves what follows.
 */
export function webmWithDuration(bytes: Uint8Array, durationMs: number): { head: Uint8Array<ArrayBuffer>; consumed: number } | null {
  if (!(durationMs > 0)) return null;
  const ebmlId = readId(bytes, 0);
  const ebmlSize = ebmlId && readSize(bytes, ebmlId.length);
  if (ebmlId?.value !== EBML || !ebmlSize || ebmlSize.unknown) return null;
  const segmentAt = ebmlId.length + ebmlSize.length + ebmlSize.value;
  const segmentId = readId(bytes, segmentAt);
  const segmentSize = segmentId && readSize(bytes, segmentAt + segmentId.length);
  if (segmentId?.value !== SEGMENT || !segmentSize) return null;

  // Info is among the Segment's first children; a Void may come before it.
  let at = segmentAt + segmentId.length + segmentSize.length;
  for (;;) {
    const id = readId(bytes, at);
    const size = id && readSize(bytes, at + id.length);
    if (!id || !size || size.unknown) return null;
    const dataAt = at + id.length + size.length;
    if (id.value === VOID) {
      at = dataAt + size.value;
      continue;
    }
    // Anything else first (a SeekHead, say, which addresses what follows by
    // position) and it's left as it is.
    if (id.value !== INFO || dataAt + size.value > bytes.length) return null;
    return patchInfo(bytes, { segmentAt, segmentId, segmentSize, infoAt: at, infoId: id, infoDataAt: dataAt, infoSize: size.value }, durationMs);
  }
}

function patchInfo(
  bytes: Uint8Array,
  where: { segmentAt: number; segmentId: Vint; segmentSize: Vint; infoAt: number; infoId: Vint; infoDataAt: number; infoSize: number },
  durationMs: number,
): { head: Uint8Array<ArrayBuffer>; consumed: number } | null {
  const infoEnd = where.infoDataAt + where.infoSize;
  let scale = 1_000_000;
  let durationAt: { dataAt: number; length: number } | null = null;
  for (let at = where.infoDataAt; at < infoEnd; ) {
    const id = readId(bytes, at);
    const size = id && readSize(bytes, at + id.length);
    if (!id || !size || size.unknown) return null;
    const dataAt = at + id.length + size.length;
    if (id.value === TIMECODE_SCALE && size.value <= 6) scale = readUint(bytes, dataAt, size.value) || scale;
    if (id.value === DURATION) durationAt = { dataAt, length: size.value };
    at = dataAt + size.value;
  }
  // Duration is a float in TimecodeScale units (nanoseconds each, scaled).
  const duration = (durationMs * 1_000_000) / scale;

  // One there already (as 0, say): overwritten in place.
  if (durationAt && (durationAt.length === 8 || durationAt.length === 4)) {
    const head = bytes.slice(0, infoEnd);
    const view = new DataView(head.buffer, head.byteOffset + durationAt.dataAt, durationAt.length);
    if (durationAt.length === 8) view.setFloat64(0, duration);
    else view.setFloat32(0, duration);
    return { head, consumed: infoEnd };
  }
  if (durationAt) return null;

  // Otherwise added at the end of Info: ID 0x4489, size 8, a float64.
  const added = new Uint8Array(11);
  added.set([0x44, 0x89, 0x88]);
  new DataView(added.buffer).setFloat64(3, duration);
  const infoSize = writeSize(where.infoSize + added.length, 8);
  if (!infoSize) return null;

  // A Segment of known size (not a streamed one) grows by as much.
  const segmentHeaderEnd = where.segmentAt + where.segmentId.length + where.segmentSize.length;
  let segmentSize: Uint8Array = bytes.slice(where.segmentAt + where.segmentId.length, segmentHeaderEnd);
  if (!where.segmentSize.unknown) {
    const infoGrowth = added.length + infoSize.length - (where.infoDataAt - where.infoAt - where.infoId.length);
    const grown = writeSize(where.segmentSize.value + infoGrowth, where.segmentSize.length);
    if (!grown) return null;
    segmentSize = grown;
  }

  const parts = [
    bytes.subarray(0, where.segmentAt + where.segmentId.length),
    segmentSize,
    bytes.subarray(segmentHeaderEnd, where.infoAt + where.infoId.length),
    infoSize,
    bytes.subarray(where.infoDataAt, infoEnd),
    added,
  ];
  const head = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    head.set(part, offset);
    offset += part.length;
  }
  return { head, consumed: infoEnd };
}
