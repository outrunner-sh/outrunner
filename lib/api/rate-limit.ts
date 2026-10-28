/**
 * How often one key may call the public API: a budget per minute, refilled
 * continuously (a token bucket), so a script that spreads its calls never
 * notices and one in a tight loop is told to wait. Starting a session costs
 * more of it than reading one, since each starts a box.
 *
 * Kept in this server's memory: Outrunner runs as one long-running server
 * (server.ts), and a restart forgets only how much of a minute was spent.
 */

export type RateLimitRule = {
  /** Calls a minute, and so the most that can be spent at once. */
  perMinute: number;
};

/** Reads and actions on what exists. */
export const DEFAULT_LIMIT: RateLimitRule = { perMinute: 120 };
/** Starting a session. */
export const CREATE_LIMIT: RateLimitRule = { perMinute: 10 };

export type RateDecision = {
  allowed: boolean;
  limit: number;
  /** Whole calls left now. */
  remaining: number;
  /** Seconds until one more call is allowed (0 when one is now). */
  retryAfter: number;
};

type Bucket = { tokens: number; at: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor({ now = Date.now, maxKeys = 10_000 }: { now?: () => number; maxKeys?: number } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** Spend one call of `key`'s budget under `rule`, if there's one to spend. */
  take(key: string, rule: RateLimitRule): RateDecision {
    const now = this.now();
    const perMs = rule.perMinute / 60_000;
    const held = this.buckets.get(key);
    const tokens = held ? Math.min(rule.perMinute, held.tokens + (now - held.at) * perMs) : rule.perMinute;
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return { allowed: false, limit: rule.perMinute, remaining: 0, retryAfter: Math.ceil((1 - tokens) / perMs / 1000) };
    }
    // A full bucket is forgotten, so keys that stop calling don't stay held.
    if (!held && this.buckets.size >= this.maxKeys) this.forgetFull(now);
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    return { allowed: true, limit: rule.perMinute, remaining: Math.floor(tokens - 1), retryAfter: 0 };
  }

  private forgetFull(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > 60_000) this.buckets.delete(key);
    }
  }
}

/** The headers a decision is told to the caller with. */
export function rateHeaders(decision: RateDecision): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    ...(decision.allowed ? {} : { "Retry-After": String(Math.max(1, decision.retryAfter)) }),
  };
}
