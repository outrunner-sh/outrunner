import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKOFF_SECONDS,
  isPrivateAddress,
  nextAttemptAt,
  signature,
  signatureMatches,
  watchStep,
  webhookUrl,
  type WatchState,
} from "@/lib/api/webhooks";

const SECRET = "whsec_test";

test("a delivery is signed over its time and body, and checked as a receiver would", () => {
  const body = JSON.stringify({ type: "turn.completed" });
  const now = Date.parse("2026-11-02T12:00:00Z");
  const t = Math.floor(now / 1000);
  const header = signature(SECRET, body, t);
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(signatureMatches(SECRET, body, header, now), true);
  assert.equal(signatureMatches("whsec_other", body, header, now), false);
  assert.equal(signatureMatches(SECRET, `${body} `, header, now), false);
  // Replayed later than five minutes on: refused.
  assert.equal(signatureMatches(SECRET, body, header, now + 301_000), false);
  assert.equal(signatureMatches(SECRET, body, null, now), false);
});

test("only https URLs on the public internet are told", () => {
  assert.equal(webhookUrl("https://hooks.example.com/outrunner"), "https://hooks.example.com/outrunner");
  assert.equal(webhookUrl(null), null);
  assert.equal(webhookUrl(""), null);
  for (const refused of [
    "http://hooks.example.com",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/x",
    "https://[::1]/x",
    "https://box.internal/x",
    "https://user:pass@hooks.example.com",
    "not a url",
    42,
  ]) {
    assert.equal(webhookUrl(refused), undefined, String(refused));
  }
});

test("private, loopback and link-local addresses are told apart from public ones", () => {
  for (const address of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("a failed delivery is tried again with longer waits, then given up", () => {
  const now = 0;
  assert.equal(nextAttemptAt(1, now), new Date(30_000).toISOString());
  assert.equal(nextAttemptAt(2, now), new Date(120_000).toISOString());
  assert.equal(nextAttemptAt(BACKOFF_SECONDS.length, now), new Date(BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1] * 1000).toISOString());
  assert.equal(nextAttemptAt(BACKOFF_SECONDS.length + 1, now), null);
});

const awaiting: WatchState = { awaiting: true, seenWorking: false, baselineEvent: null, askedToolUse: null };

test("a turn seen working, then idle, is told as completed once", () => {
  const working = watchStep(awaiting, { state: "working", last_event_id: "10", pending_input: null });
  assert.deepEqual(working.events, []);
  const done = watchStep(working.next, { state: "idle", last_event_id: "20", pending_input: null });
  assert.deepEqual(done.events, ["turn.completed"]);
  assert.equal(done.next.awaiting, false);
  assert.deepEqual(watchStep(done.next, { state: "idle", last_event_id: "20", pending_input: null }).events, []);
});

test("a turn too quick to be caught working counts once the log moves on", () => {
  // First look: the prompt isn't in the log yet, and it reads idle.
  const first = watchStep(awaiting, { state: "idle", last_event_id: "5", pending_input: null });
  assert.deepEqual(first.events, []);
  assert.equal(first.next.baselineEvent, "5");
  // Same place: still waiting.
  assert.deepEqual(watchStep(first.next, { state: "idle", last_event_id: "5", pending_input: null }).events, []);
  // The prompt and its reply came and went between looks.
  assert.deepEqual(watchStep(first.next, { state: "idle", last_event_id: "9", pending_input: null }).events, ["turn.completed"]);
});

test("a question is told once, and again only for a new one", () => {
  const asked = watchStep(awaiting, { state: "needs_input", last_event_id: "7", pending_input: { tool_use_id: "q1" } });
  assert.deepEqual(asked.events, ["needs_input"]);
  assert.equal(asked.next.awaiting, true);
  assert.deepEqual(watchStep(asked.next, { state: "needs_input", last_event_id: "7", pending_input: { tool_use_id: "q1" } }).events, []);
  const answered = watchStep(asked.next, { state: "working", last_event_id: "8", pending_input: null });
  assert.deepEqual(
    watchStep(answered.next, { state: "needs_input", last_event_id: "9", pending_input: { tool_use_id: "q2" } }).events,
    ["needs_input"],
  );
});

test("a box that didn't answer changes nothing", () => {
  assert.deepEqual(watchStep(awaiting, null), { events: [], next: awaiting });
});
