import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_ATTACHMENT_BYTES, safeFilename } from "@/lib/runtime/attachments";
import {
  FRAME_MAX_WIDTH,
  MAX_FRAMES,
  RECORDING_BITS_PER_SECOND,
  RECORDING_LIMIT_MS,
  fileType,
  frameName,
  frameSize,
  pickFrames,
  recordingBase,
  recordingClock,
  recordingFiles,
  recordingFormat,
  recordingStartNotice,
  recordingTitle,
  shouldStopForSize,
  stoppedNotice,
  withLastFrame,
} from "@/lib/session/screen-recording";

test("recordingFormat takes the first format the browser records", () => {
  const chrome = recordingFormat((type) => type.startsWith("video/webm"));
  assert.equal(chrome?.mimeType, "video/webm;codecs=vp9");
  assert.equal(chrome && fileType(chrome), "video/webm");

  const safari = recordingFormat((type) => type === "video/mp4");
  assert.deepEqual(safari, { mimeType: "video/mp4", extension: "mp4" });

  assert.equal(recordingFormat(() => false), null);
});

test("a full recording at the asked bitrate never meets the size limit", () => {
  const perSecond = RECORDING_BITS_PER_SECOND / 8;
  const bytes = perSecond * (RECORDING_LIMIT_MS / 1000);
  assert.equal(shouldStopForSize(bytes, perSecond), false);
});

test("a busy screen stops with room left for the flush", () => {
  // Measured in Chrome: about 11.7 Mbps for fast motion, a chunk a second.
  const chunk = 11_700_000 / 8;
  let bytes = 0;
  while (!shouldStopForSize(bytes, chunk)) bytes += chunk;
  // Stopping flushes about one more chunk.
  assert.ok(bytes + chunk < MAX_ATTACHMENT_BYTES);
  assert.ok(bytes > MAX_ATTACHMENT_BYTES / 2);
});

test("pickFrames spreads frames from the first to the last", () => {
  const frames = Array.from({ length: 60 }, (_, i) => i);
  const picked = pickFrames(frames);
  assert.equal(picked.length, MAX_FRAMES);
  assert.equal(picked[0], 0);
  assert.equal(picked.at(-1), 59);
  assert.deepEqual([...picked].sort((a, b) => a - b), picked);
  assert.equal(new Set(picked).size, picked.length);
});

test("pickFrames keeps every frame of a short recording", () => {
  assert.deepEqual(pickFrames([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(pickFrames([]), []);
});

test("pickFrames with room for one keeps the last frame", () => {
  assert.deepEqual(pickFrames([1, 2, 3, 4], 1), [4]);
  assert.deepEqual(pickFrames([1, 2, 3, 4], 0), []);
  assert.deepEqual(pickFrames([1, 2, 3, 4], -2), []);
});

test("recordingFiles attaches the video first, then the frames that fit", () => {
  const frames = ["f0", "f1", "f2", "f3", "f4", "f5"];
  assert.deepEqual(recordingFiles("video", frames, 10), { files: ["video", ...frames], notice: null });

  const tight = recordingFiles("video", frames, 3);
  assert.deepEqual(tight.files, ["video", "f0", "f5"]);
  assert.match(tight.notice ?? "", /2 of its frames/);

  assert.deepEqual(recordingFiles("video", frames, 0).files, []);
  assert.match(recordingFiles("video", frames, 0).notice ?? "", /No room/);
});

test("with room for one file, recordingFiles attaches the last frame, which the agent can see", () => {
  const one = recordingFiles("video", ["f0", "f1", "f2"], 1);
  assert.deepEqual(one.files, ["f2"]);
  assert.match(one.notice ?? "", /last frame is attached, not the video/);
  // No frame to show (it ended before the first): the video, then.
  assert.deepEqual(recordingFiles("video", [], 1).files, ["video"]);
});

test("recordingFiles says nothing when the recording had few frames", () => {
  assert.deepEqual(recordingFiles("video", ["f0"], 10), { files: ["video", "f0"], notice: null });
});

test("names sort in recording order and survive the upload's clean-up", () => {
  const base = recordingBase(new Date(2026, 9, 30, 14, 3, 5));
  assert.equal(base, "recording-2026-10-30-140305");
  assert.equal(frameName(base, 4_000), "recording-2026-10-30-140305-0m04.0s.jpg");
  assert.equal(frameName(base, 61_440), "recording-2026-10-30-140305-1m01.4s.jpg");
  assert.equal(frameName(base, -5), "recording-2026-10-30-140305-0m00.0s.jpg");
  for (const name of [`${base}.webm`, frameName(base, 4_000)]) assert.equal(safeFilename(name), name);
  // Frames within the same second get names of their own, in order.
  const names = [14_000, 14_200, 14_900, 70_000].map((at) => frameName(base, at));
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), names);
});

test("withLastFrame drops a periodic frame taken just before the last", () => {
  const frames = [{ atMs: 1_000 }, { atMs: 2_000 }, { atMs: 3_000 }];
  assert.deepEqual(withLastFrame(frames, { atMs: 3_200 }), [{ atMs: 1_000 }, { atMs: 2_000 }, { atMs: 3_200 }]);
  assert.deepEqual(withLastFrame(frames, { atMs: 3_600 }).length, 4);
  assert.deepEqual(withLastFrame(frames, null), frames);
});

test("a limit that ends the recording says so; the user ending it doesn't", () => {
  assert.equal(stoppedNotice("user", 30_000), null);
  assert.match(stoppedNotice("time", RECORDING_LIMIT_MS) ?? "", /stopped at 2:00/);
  assert.match(stoppedNotice("size", 81_000) ?? "", /stopped at 1:21/);
});

test("recordingTitle leads with the time, so the tab is found again", () => {
  assert.equal(recordingTitle("0:42", "Outrunner"), "● 0:42 Recording · Outrunner");
});

test("recordingClock counts minutes and seconds", () => {
  assert.equal(recordingClock(0), "0:00");
  assert.equal(recordingClock(7_900), "0:07");
  assert.equal(recordingClock(102_000), "1:42");
});

test("frameSize scales a wide screen down, keeping its shape", () => {
  assert.deepEqual(frameSize(1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(frameSize(3200, 1800), { width: FRAME_MAX_WIDTH, height: 900 });
});

test("recordingStartNotice is quiet when the picker is closed", () => {
  const closed = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  const blocked = Object.assign(new Error("Permission denied by system"), { name: "NotAllowedError" });
  assert.equal(recordingStartNotice(closed), null);
  assert.equal(recordingStartNotice(Object.assign(new Error(""), { name: "AbortError" })), null);
  assert.match(recordingStartNotice(blocked) ?? "", /Screen Recording/);
  assert.equal(recordingStartNotice(new Error("boom")), "Couldn't start recording the screen.");
});
