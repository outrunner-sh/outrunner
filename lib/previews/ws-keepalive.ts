import type { Duplex } from "node:stream";

/**
 * Keeps a preview's WebSocket open while it's idle. The preview proxy passes
 * a WebSocket's bytes through untouched (proxy.ts), so nothing pings either
 * leg, and an idle one (a dev server's hot reload with nothing to say) is cut
 * by Cloudflare in front of us after about 100 s, or by a proxy between us
 * and the box. So every {@link PREVIEW_PING_MS} this sends the browser a
 * ping frame of its own, but only between the box's frames, never inside
 * one. The browser answers with a pong, which goes on to the box's server: a
 * pong it didn't ask for, which RFC 6455 (5.5.3) has it ignore. Both legs
 * carry a frame either way.
 */

export const PREVIEW_PING_MS = 25_000;
/** A server's ping with no payload: FIN + opcode 0x9, unmasked, length 0. */
export const PING_FRAME = Buffer.from([0x89, 0x00]);

/** Follows the frames of one direction of a WebSocket, to tell when the
 *  bytes so far end on a frame boundary. Exported for tests. */
export class FrameBoundary {
  private header: number[] = [];
  private remaining = 0;

  feed(chunk: Buffer): void {
    let i = 0;
    while (i < chunk.length) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - i);
        this.remaining -= take;
        i += take;
        continue;
      }
      this.header.push(chunk[i]!);
      i += 1;
      if (this.header.length < 2) continue;
      const len7 = this.header[1]! & 0x7f;
      const ext = len7 === 126 ? 2 : len7 === 127 ? 8 : 0;
      const mask = this.header[1]! & 0x80 ? 4 : 0;
      if (this.header.length < 2 + ext + mask) continue;
      let length = len7;
      if (ext > 0) {
        length = 0;
        for (let b = 0; b < ext; b += 1) length = length * 256 + this.header[2 + b]!;
      }
      this.header = [];
      this.remaining = length;
    }
  }

  /** Whether the bytes fed so far end where a frame does. */
  atBoundary(): boolean {
    return this.header.length === 0 && this.remaining === 0;
  }
}

/** Ping the browser on `browser` every `pingMs` while the box's bytes
 *  (`fromBox`, after `head`) are between frames; stops when either closes. */
export function keepPreviewSocketAlive(browser: Duplex, fromBox: Duplex, head: Buffer, pingMs = PREVIEW_PING_MS): void {
  const frames = new FrameBoundary();
  if (head.length) frames.feed(head);
  // Alongside the pipe that writes the same bytes on: in the same tick, so
  // the boundary here is the boundary of what the browser has been sent.
  fromBox.on("data", (chunk: Buffer) => frames.feed(chunk));
  const timer = setInterval(() => {
    if (frames.atBoundary() && !browser.destroyed && browser.writable) browser.write(PING_FRAME);
  }, pingMs);
  timer.unref();
  const stop = () => clearInterval(timer);
  browser.once("close", stop);
  fromBox.once("close", stop);
}
