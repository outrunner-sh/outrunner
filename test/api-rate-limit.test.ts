import assert from "node:assert/strict";
import { test } from "node:test";

import { RateLimiter, rateHeaders } from "@/lib/api/rate-limit";

test("a key may spend its minute's budget at once, then waits for it to refill", () => {
  let now = 0;
  const limiter = new RateLimiter({ now: () => now });
  const rule = { perMinute: 3 };
  assert.equal(limiter.take("k", rule).remaining, 2);
  limiter.take("k", rule);
  assert.equal(limiter.take("k", rule).remaining, 0);
  const refused = limiter.take("k", rule);
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfter, 20);
  assert.equal(rateHeaders(refused)["Retry-After"], "20");
  now += 20_000;
  assert.equal(limiter.take("k", rule).allowed, true);
});

test("keys and buckets are counted apart", () => {
  const limiter = new RateLimiter({ now: () => 0 });
  const rule = { perMinute: 1 };
  assert.equal(limiter.take("a:create", rule).allowed, true);
  assert.equal(limiter.take("a:create", rule).allowed, false);
  assert.equal(limiter.take("a:default", rule).allowed, true);
  assert.equal(limiter.take("b:create", rule).allowed, true);
});

test("several calls are spent at once, or none of them", () => {
  const limiter = new RateLimiter({ now: () => 0 });
  const rule = { perMinute: 10 };
  assert.equal(limiter.take("k", rule, 7).remaining, 3);
  const refused = limiter.take("k", rule, 5);
  assert.equal(refused.allowed, false);
  // Nothing was spent by the refusal.
  assert.equal(limiter.take("k", rule, 3).allowed, true);
});

test("an allowed call's headers say what's left, with no Retry-After", () => {
  const headers = rateHeaders({ allowed: true, limit: 120, remaining: 7, retryAfter: 0 });
  assert.deepEqual(headers, { "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "7" });
});
