"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { canShowNotifications } from "@/lib/notifications/show";
import {
  CAPTURE_MAX,
  FRAME_EVERY_MS,
  fileType,
  frameName,
  frameSize,
  pickFrames,
  RECORDING_BITS_PER_SECOND,
  RECORDING_LIMIT_MS,
  recordingBase,
  recordingClock,
  recordingFormat,
  type RecordingFormat,
  recordingStartNotice,
  recordingTitle,
  shouldStopForSize,
  type StoppedBy,
  withLastFrame,
} from "@/lib/session/screen-recording";
import { WEBM_HEAD_BYTES, webmWithDuration } from "@/lib/session/webm-duration";

export type ScreenRecording = { video: File; frames: File[]; stoppedBy: StoppedBy; durationMs: number };

type Frame = { atMs: number; blob: Blob };

/** One recording in flight: the screen's stream, what records it, and the
 *  frames taken from it so far. */
type Session = {
  stream: MediaStream;
  recorder: MediaRecorder;
  format: RecordingFormat;
  startedAt: number;
  video: HTMLVideoElement;
  frames: Frame[];
  /** The frame taken as it stopped, while the recorder flushes. */
  lastFrame: Promise<Frame | null> | null;
  stoppedBy: StoppedBy | null;
  /** Clears its frame and time-limit timers. */
  clearTimers: () => void;
  /** The tab's title before recording, and what this put there since. */
  title: { before: string; shown: string | null };
};

/** The format this browser records in, or null where it can't record the
 *  screen (phones, tablets, older browsers). Null on the server and through
 *  hydration. */
function supportedFormat(): RecordingFormat | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) return null;
  if (typeof MediaRecorder === "undefined") return null;
  return recordingFormat((type) => MediaRecorder.isTypeSupported(type));
}
const noSubscribe = () => () => {};

/** A frame of the screen as it is now, `atMs` into the recording, as a JPEG,
 *  or null if there's none yet. The picture is taken at once; only the
 *  encoding waits. */
function grabFrame(video: HTMLVideoElement, atMs: number): Promise<Frame | null> {
  if (video.videoWidth === 0 || video.videoHeight === 0) return Promise.resolve(null);
  const { width, height } = frameSize(video.videoWidth, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob && { atMs, blob }), "image/jpeg", 0.85));
}

/** The recording with its length written in, so players show it and a seek
 *  bar (lib/session/webm-duration.ts); as it was if it can't be. */
async function withDuration(video: Blob, durationMs: number): Promise<Blob> {
  try {
    const head = new Uint8Array(await video.slice(0, WEBM_HEAD_BYTES).arrayBuffer());
    const patched = webmWithDuration(head, durationMs);
    return patched ? new Blob([patched.head, video.slice(patched.consumed)], { type: video.type }) : video;
  } catch {
    return video;
  }
}

/** Put the tab's title back, unless the app has changed it since. */
function restoreTitle(title: Session["title"]) {
  if (title.shown !== null && document.title === title.shown) document.title = title.before;
  title.shown = null;
}

/**
 * The tab, once a recording has ended there while the user is on another
 * (Chrome switches to a shared tab): its title says the recording is
 * attached, and a notification, where they're allowed, brings them back.
 */
function callBack(title: Session["title"]) {
  if (document.visibilityState === "visible") return restoreTitle(title);
  if (title.shown === null || document.title === title.shown) {
    title.shown = `Recording attached · ${title.before}`;
    document.title = title.shown;
  }
  const back = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", back);
    restoreTitle(title);
  };
  document.addEventListener("visibilitychange", back);
  if (!canShowNotifications()) return;
  const shown = new Notification("Recording attached", { body: "Go back to Outrunner to send it.", tag: "screen-recording" });
  shown.onclick = () => {
    window.focus();
    shown.close();
  };
}

/**
 * Record the user's screen from the composer (NEE-263). `start` asks the
 * browser which screen, window or tab to share; the recording ends at `stop`,
 * when the user stops sharing from the browser's own bar, at the length or
 * size limit (lib/session/screen-recording.ts), or when the composer goes
 * (a question card standing in for it): it is kept, not dropped. `onRecorded`
 * then gets the video and up to MAX_FRAMES frames from it, spread over its
 * length.
 */
export function useScreenRecorder({
  onRecorded,
  onNotice,
}: {
  onRecorded: (recording: ScreenRecording) => void;
  onNotice: (notice: string) => void;
}) {
  const format = useSyncExternalStore(noSubscribe, supportedFormat, () => null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const session = useRef<Session | null>(null);
  const handlers = useRef({ onRecorded, onNotice });
  useEffect(() => {
    handlers.current = { onRecorded, onNotice };
  });

  const stop = useCallback((reason: StoppedBy = "user") => {
    const current = session.current;
    // Once: Stop, the browser's "Stop sharing" and the limits can all land.
    if (!current || current.stoppedBy || current.recorder.state === "inactive") return;
    current.stoppedBy = reason;
    current.clearTimers();
    // The screen as the recording ends, unless the user ended it by stopping
    // the share (the stream has no picture left to take). Taken before the
    // recorder stops; it is encoded while the recorder flushes.
    if (current.stream.getVideoTracks().some((track) => track.readyState === "live")) {
      current.lastFrame = grabFrame(current.video, Date.now() - current.startedAt);
    }
    current.recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (!format || session.current || starting) return;
    setStarting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: CAPTURE_MAX.width }, height: { max: CAPTURE_MAX.height }, frameRate: { max: 15 } },
        audio: false,
      });
    } catch (error) {
      const notice = recordingStartNotice(error);
      if (notice) handlers.current.onNotice(notice);
      setStarting(false);
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: format.mimeType, videoBitsPerSecond: RECORDING_BITS_PER_SECOND });
    } catch {
      for (const track of stream.getTracks()) track.stop();
      handlers.current.onNotice("Couldn't start recording the screen.");
      setStarting(false);
      return;
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    void video.play().catch(() => {});

    const now = Date.now();
    const current: Session = {
      stream,
      recorder,
      format,
      startedAt: now,
      video,
      frames: [],
      lastFrame: null,
      stoppedBy: null,
      clearTimers: () => {},
      title: { before: document.title, shown: null },
    };
    session.current = current;
    const chunks: Blob[] = [];
    let bytes = 0;

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      chunks.push(event.data);
      bytes += event.data.size;
      if (shouldStopForSize(bytes, event.data.size)) stop("size");
    };
    recorder.onstop = async () => {
      const durationMs = Date.now() - current.startedAt;
      const last = await current.lastFrame;
      for (const track of current.stream.getTracks()) track.stop();
      current.video.srcObject = null;
      if (session.current === current) session.current = null;
      setStartedAt(null);
      if (chunks.length === 0) return restoreTitle(current.title);
      const base = recordingBase(new Date(current.startedAt));
      const type = fileType(current.format);
      const recorded = new Blob(chunks, { type });
      const file = new File([type === "video/webm" ? await withDuration(recorded, durationMs) : recorded], `${base}.${current.format.extension}`, { type });
      const frames = pickFrames(withLastFrame(current.frames, last)).map(
        (frame) => new File([frame.blob], frameName(base, frame.atMs), { type: "image/jpeg" }),
      );
      handlers.current.onRecorded({ video: file, frames, stoppedBy: current.stoppedBy ?? "user", durationMs });
      callBack(current.title);
    };
    // The browser's own "Stop sharing" ends the recording the same way.
    for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => stop());

    // Each second: a frame, and the time in the tab's title.
    const tick = window.setInterval(() => {
      const atMs = Date.now() - now;
      void grabFrame(video, atMs).then((frame) => {
        if (frame && !current.stoppedBy) current.frames.push(frame);
      });
      if (current.title.shown === null || document.title === current.title.shown) {
        current.title.shown = recordingTitle(recordingClock(atMs), current.title.before);
        document.title = current.title.shown;
      }
    }, FRAME_EVERY_MS);
    const limitTimer = window.setTimeout(() => stop("time"), RECORDING_LIMIT_MS);
    current.clearTimers = () => {
      window.clearInterval(tick);
      window.clearTimeout(limitTimer);
    };
    // A chunk a second, so the size limit is checked as it records.
    recorder.start(1000);
    setStartedAt(now);
    setStarting(false);
  }, [format, starting, stop]);

  // The composer going mid-recording (a question card stands in for it, or
  // the page moves on) ends the recording into the draft, as Stop does.
  useEffect(() => () => stop(), [stop]);

  return { supported: format !== null, starting, recording: startedAt !== null, startedAt, start, stop: () => stop() };
}
