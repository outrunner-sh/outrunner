import { MAX_ATTACHMENT_BYTES } from "@/lib/runtime/attachments";

/**
 * A screen recording from the composer: the video, attached as a
 * file, and a few frames of it, attached as images the agent can see (it
 * can't watch a video). The browser side is hooks/use-screen-recorder.ts.
 */

/** A recording stops itself after this long. */
export const RECORDING_LIMIT_MS = 2 * 60_000;
/** From here the composer says the recording is about to stop. */
export const RECORDING_WARN_AT_MS = RECORDING_LIMIT_MS - 15_000;
/** Asked of the browser; busy screens can run several times over it, which
 *  the size limit (shouldStopForSize) catches. */
export const RECORDING_BITS_PER_SECOND = 1_500_000;
/** The screen is captured at most this size: past it the file grows, the
 *  frames are scaled down anyway, and the agent sees no more. */
export const CAPTURE_MAX = { width: 1920, height: 1080 } as const;
/** How often a frame is taken while recording. */
export const FRAME_EVERY_MS = 1_000;
/** The most frames attached with a recording. */
export const MAX_FRAMES = 6;
/** Frames wider than this are scaled down. */
export const FRAME_MAX_WIDTH = 1600;
/** A frame taken this close before the last one says nothing new. */
const FRAME_MIN_GAP_MS = 500;

/** Why a recording ended: the user (Stop, the browser's "Stop sharing", or
 *  leaving the composer), or a limit. */
export type StoppedBy = "user" | "time" | "size";

/** What MediaRecorder is asked to record in, the first it takes: WebM in
 *  Chrome and Firefox, MP4 in Safari. */
const FORMATS = [
  { mimeType: "video/webm;codecs=vp9", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
  { mimeType: "video/mp4", extension: "mp4" },
] as const;

export type RecordingFormat = (typeof FORMATS)[number];

/** The format to record in, or null when the browser records none of them. */
export function recordingFormat(isTypeSupported: (mimeType: string) => boolean): RecordingFormat | null {
  return FORMATS.find((format) => isTypeSupported(format.mimeType)) ?? null;
}

/** The file's own type, without codecs: "video/webm". */
export function fileType(format: RecordingFormat): string {
  return format.mimeType.split(";")[0];
}

/**
 * Whether to stop now so the file stays under the attachment limit, with
 * `bytes` recorded so far and `lastChunk` the latest second's: room is kept
 * for three more seconds at that rate (the flush after stopping is one),
 * and a megabyte besides.
 */
export function shouldStopForSize(bytes: number, lastChunk: number, limit: number = MAX_ATTACHMENT_BYTES): boolean {
  return bytes + 3 * lastChunk >= limit - 1024 * 1024;
}

/**
 * Up to `room` (and MAX_FRAMES) of `frames`, spread evenly from the first to
 * the last, which is always kept: how the recording ended is what it shows.
 */
export function pickFrames<T>(frames: readonly T[], room: number = MAX_FRAMES): T[] {
  const n = Math.min(MAX_FRAMES, Math.max(0, Math.floor(room)), frames.length);
  if (n === 0) return [];
  if (n === 1) return [frames[frames.length - 1]];
  const step = (frames.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, k) => frames[Math.round(k * step)]);
}

/** The frames with the one taken as the recording ended, in place of a
 *  periodic one taken just before it. */
export function withLastFrame<T extends { atMs: number }>(frames: readonly T[], last: T | null): T[] {
  if (!last) return [...frames];
  const kept = frames.filter((frame) => last.atMs - frame.atMs >= FRAME_MIN_GAP_MS);
  return [...kept, last];
}

/** The recording's name, from when it started: `recording-2026-10-30-143205`. */
export function recordingBase(startedAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`;
  const time = `${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
  return `recording-${day}-${time}`;
}

/** A frame's name, by how far into the recording it is, to a tenth of a
 *  second: `…-0m04.2s.jpg`, so the agent reads them in order. */
export function frameName(base: string, atMs: number): string {
  const tenths = Math.max(0, Math.round(atMs / 100));
  const seconds = Math.floor(tenths / 10);
  return `${base}-${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}.${tenths % 10}s.jpg`;
}

/** How long it has been recording, for the composer: "0:07", "1:42". */
export function recordingClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The tab's title while recording, so the tab is found again from the one
 *  being recorded: "● 0:42 Recording · Outrunner". */
export function recordingTitle(clock: string, title: string): string {
  return `● ${clock} Recording · ${title}`;
}

/** A frame's size, `width` × `height` scaled to at most FRAME_MAX_WIDTH wide. */
export function frameSize(width: number, height: number): { width: number; height: number } {
  if (width <= FRAME_MAX_WIDTH) return { width, height };
  return { width: FRAME_MAX_WIDTH, height: Math.round((height * FRAME_MAX_WIDTH) / width) };
}

/** What the composer says when a recording can't start, or null to say
 *  nothing (the user closed the browser's picker). */
export function recordingStartNotice(error: unknown): string | null {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  const message = error instanceof Error || error instanceof DOMException ? error.message : "";
  // Chrome on a Mac that hasn't let it record the screen: "Permission denied
  // by system". The user closing the picker is plain "Permission denied".
  if (name === "NotAllowedError" && /system/i.test(message)) {
    return "Your computer isn't letting the browser record the screen. Allow it in System Settings → Privacy & Security → Screen Recording, then try again.";
  }
  if (name === "NotAllowedError" || name === "AbortError") return null;
  return "Couldn't start recording the screen.";
}

/** What the composer says about a recording a limit ended, or null when the
 *  user ended it. */
export function stoppedNotice(stoppedBy: StoppedBy, durationMs: number): string | null {
  if (stoppedBy === "time") return `Recording stopped at ${recordingClock(RECORDING_LIMIT_MS)}, the longest one can be.`;
  if (stoppedBy === "size") return `Recording stopped at ${recordingClock(durationMs)}: it reached the most one file can be.`;
  return null;
}

/**
 * The files a recording attaches, with `room` for files left in the
 * message: the video, then as many of its frames as fit. With room for one,
 * the last frame, which the agent can see, rather than the video it can't.
 */
export function recordingFiles<T>(
  video: T,
  frames: readonly T[],
  room: number,
): { files: T[]; notice: string | null } {
  if (room < 1) return { files: [], notice: "No room for the recording: remove a file first." };
  if (room === 1 && frames.length > 0) {
    return {
      files: [frames[frames.length - 1]],
      notice: "Room for one more file: the recording's last frame is attached, not the video.",
    };
  }
  const kept = pickFrames(frames, room - 1);
  const short = Math.min(MAX_FRAMES, frames.length) - kept.length;
  return {
    files: [video, ...kept],
    notice: short > 0 ? `The recording is attached with ${kept.length} of its frames: no room for more files.` : null,
  };
}
