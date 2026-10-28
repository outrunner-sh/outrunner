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
  for (const address of [
    "10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1",
    // IPv4 in IPv6, however it's written: the URL parser writes the hex form.
    "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::7f00:1", "::127.0.0.1",
    // NAT64 and 6to4 reach IPv4 through a gateway.
    "64:ff9b::808:808", "2002:c000:204::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:808:808"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("an IPv4-mapped loopback in a URL is refused, as the parser writes it", () => {
  assert.equal(new URL("https://[::ffff:127.0.0.1]/").hostname, "[::ffff:7f00:1]");
  assert.equal(webhookUrl("https://[::ffff:127.0.0.1]/"), undefined);
  assert.equal(webhookUrl("https://[::ffff:169.254.169.254]/latest"), undefined);
});

test("a failed delivery is tried again with longer waits, then given up", () => {
  const now = 0;
  assert.equal(nextAttemptAt(1, now), new Date(30_000).toISOString());
  assert.equal(nextAttemptAt(2, now), new Date(120_000).toISOString());
  assert.equal(nextAttemptAt(BACKOFF_SECONDS.length, now), new Date(BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1] * 1000).toISOString());
  assert.equal(nextAttemptAt(BACKOFF_SECONDS.length + 1, now), null);
});

const awaiting: WatchState = { awaiting: true, seenWorking: false, baselineEvent: null, baselineFenced: false, askedToolUse: null };

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

test("two looks at an empty log aren't the log moving on", () => {
  const first = watchStep(awaiting, { state: "idle", last_event_id: null, pending_input: null });
  assert.deepEqual(first.events, []);
  assert.deepEqual(watchStep(first.next, { state: "idle", last_event_id: null, pending_input: null }).events, []);
});

test("from the send's fence, a turn already over at the first look is told", () => {
  // The fence (where the log stood before the message) is the baseline: a
  // short reply done before anyone looked still moved the log on.
  const fenced: WatchState = { ...awaiting, baselineEvent: "200", baselineFenced: true };
  assert.deepEqual(watchStep(fenced, { state: "idle", last_event_id: "380", pending_input: null, prompted: true }).events, ["turn.completed"]);
  // A session's first prompt: from an empty log.
  const first: WatchState = { ...awaiting, baselineEvent: "0", baselineFenced: true };
  assert.deepEqual(watchStep(first, { state: "idle", last_event_id: null, pending_input: null, prompted: false }).events, []);
  assert.deepEqual(watchStep(first, { state: "idle", last_event_id: "90", pending_input: null, prompted: true }).events, ["turn.completed"]);
});

test("an entry that isn't a prompt doesn't move the log on", () => {
  // Right after ready: the log holds something (a usage record), not the prompt.
  const first: WatchState = { ...awaiting, baselineEvent: "0", baselineFenced: true };
  const early = watchStep(first, { state: "idle", last_event_id: "40", pending_input: null, prompted: false });
  assert.deepEqual(early.events, []);
  assert.equal(early.next.awaiting, true);
});

test("from a first look's baseline, a quick turn still counts once the log moves on", () => {
  // No fence from the send: the first look found the log just past the
  // prompt, so no prompt is past the baseline, and moving on must be enough.
  const looked = watchStep(awaiting, { state: "idle", last_event_id: "300", pending_input: null, prompted: false });
  assert.equal(looked.next.baselineFenced, false);
  assert.deepEqual(watchStep(looked.next, { state: "idle", last_event_id: "420", pending_input: null, prompted: false }).events, ["turn.completed"]);
});

test("a box that didn't answer changes nothing", () => {
  assert.deepEqual(watchStep(awaiting, null), { events: [], next: awaiting });
});

test("a delivery's connection never resolves to a private address", async () => {
  const { publicOnlyLookup } = await import("@/lib/api/webhook-lookup");
  const error = await new Promise<Error | null>((resolve) =>
    publicOnlyLookup("localhost", { family: 0 }, (err) => resolve(err)),
  );
  assert.match(error?.message ?? "", /private address/);
});
