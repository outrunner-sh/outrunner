import assert from "node:assert/strict";
import { test } from "node:test";

import type { Workspace } from "@/lib/runtime/types";
import { PREFETCH_AGAIN_MS, PREFETCH_SESSIONS, sessionsToPrefetch } from "@/lib/session/prefetch-sessions";

const session = (id: string, lastActiveAt: string, more: Partial<Workspace> = {}): Workspace =>
  ({ id, status: "ready", kind: "session", lastActiveAt, createdAt: "2026-01-01T00:00:00Z", ...more }) as Workspace;

const none = { current: null, held: new Set<string>(), tried: new Map<string, number>(), now: 1_000_000 };

test("the most recently active sessions are brought in first", () => {
  const list = [
    session("old", "2026-11-10T00:00:00Z"),
    session("newest", "2026-11-17T00:00:00Z"),
    session("middle", "2026-11-15T00:00:00Z"),
  ];
  assert.deepEqual(sessionsToPrefetch(list, none), ["newest", "middle", "old"]);
});

test("not the one open, one the page already holds, nor one whose box can't be up", () => {
  const list = [
    session("open", "2026-11-17T05:00:00Z"),
    session("held", "2026-11-17T04:00:00Z"),
    session("asleep", "2026-11-17T03:00:00Z", { status: "suspended" }),
    session("archived", "2026-11-17T02:00:00Z", { status: "archived" }),
    session("mission", "2026-11-17T01:00:00Z", { kind: "mission" }),
    session("idle", "2026-11-17T00:00:00Z", { status: "idle" }),
  ];
  assert.deepEqual(sessionsToPrefetch(list, { ...none, current: "open", held: new Set(["held"]) }), ["idle"]);
});

test("only the most recent few, however many are listed", () => {
  const list = Array.from({ length: PREFETCH_SESSIONS + 5 }, (_, i) =>
    session(`s${i}`, new Date(Date.UTC(2026, 10, 1, i)).toISOString()),
  );
  const picked = sessionsToPrefetch(list, none);
  assert.equal(picked.length, PREFETCH_SESSIONS);
  assert.equal(picked[0], `s${PREFETCH_SESSIONS + 4}`);
  // Held ones count against the few: older sessions aren't reached for instead.
  const held = new Set(picked);
  assert.deepEqual(sessionsToPrefetch(list, { ...none, held }), []);
});

test("one tried lately isn't asked again until a while has passed", () => {
  const list = [session("w1", "2026-11-17T00:00:00Z")];
  const tried = new Map([["w1", 1_000_000]]);
  assert.deepEqual(sessionsToPrefetch(list, { ...none, tried, now: 1_000_000 + PREFETCH_AGAIN_MS - 1 }), []);
  assert.deepEqual(sessionsToPrefetch(list, { ...none, tried, now: 1_000_000 + PREFETCH_AGAIN_MS }), ["w1"]);
});
