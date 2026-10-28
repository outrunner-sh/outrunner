/**
 * Requests counted per key in fixed windows, in this process: the control
 * plane is one instance (cloudflare/worker.ts routes everything to it), so
 * its memory sees every request. A restart forgets the counts, which only
 * ever lets a few more through.
 */

export type Window = { ms: number; max: number };

export type Taken = { ok: true } | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  /** By key, each window's start and count. A Map keeps insertion order, so
   *  the oldest keys are the first dropped when it's full. */
  private readonly counts = new Map<string, { start: number; count: number }[]>();
  private readonly windows: readonly Window[];
  /** Keys kept at most: past it, the least recently used are dropped. */
  private readonly maxKeys: number;

  constructor(windows: readonly Window[], maxKeys = 10_000) {
    this.windows = windows;
    this.maxKeys = maxKeys;
  }

  /** Count a request for `key`: refused, saying when to try again, once any
   *  window is full. A refused request counts too, so hammering doesn't
   *  reopen it. */
  take(key: string, now = Date.now()): Taken {
    let counts = this.counts.get(key);
    if (counts) this.counts.delete(key);
    counts ??= this.windows.map(() => ({ start: now, count: 0 }));
    let retryAfter = 0;
    this.windows.forEach((window, i) => {
      const c = counts[i];
      if (now - c.start >= window.ms) {
        c.start = now;
        c.count = 0;
      }
      c.count += 1;
      if (c.count > window.max) retryAfter = Math.max(retryAfter, c.start + window.ms - now);
    });
    this.counts.set(key, counts);
    while (this.counts.size > this.maxKeys) this.counts.delete(this.counts.keys().next().value as string);
    return retryAfter > 0 ? { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfter / 1000)) } : { ok: true };
  }
}

/** Who sent a request: Cloudflare's client address, else the first
 *  forwarded one; "unknown" when neither says. */
export function clientAddress(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
