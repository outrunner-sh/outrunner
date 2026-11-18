/**
 * A Mission's inputs (docs/missions.md, "Triggers"): watched Slack channels
 * (which messages, apps only when allowed, Outrunner's own never, one
 * message one run and one request, never both the bound channel's and a
 * watch's), webhooks (a delivery key, the same key with another body
 * refused, the signature), and schedules (an occurrence's identity through
 * DST and edits, missed times folded into one).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { planScheduledRuns, type PendingRun } from "@/lib/automations/runs";
import type { ScheduleEvent } from "@/lib/automations/run-event";
import { missedSince, nextRun, occurrenceKey, scheduleRevision, type Schedule } from "@/lib/automations/schedule";
import type { RunCandidate, RunRecord } from "@/lib/db/automation-runs";
import { acceptInbound, type InboundDeps } from "@/lib/missions/slack-inbound";
import { hearing, processWatchedMessage, watchable, watchEligible, type WatchDeps } from "@/lib/missions/slack-watch";
import { checkMissionWebhook, payloadHashOf, sameDelivery, signatureOf } from "@/lib/missions/webhook-target";
import type { AgentMessage } from "@/lib/slack/agent-run";

const MISSION = "00000000-0000-0000-0000-0000000000a1";

function candidate(patch: Partial<RunCandidate> = {}): RunCandidate {
  return {
    automationId: "watch1",
    name: "Bugs",
    prompt: "p",
    triggers: ["slack.message"],
    runsAs: null,
    projectId: "p1",
    repoFullName: "acme/web",
    orgId: "o1",
    reviewers: [],
    labels: [],
    sessionMode: "new",
    target: { kind: "mission", missionId: MISSION, watch: { teamId: "T1", channelId: "C900", filterPrompt: "bugs", allowedAppIds: ["A123"] }, linearTeamIds: [] },
    ...patch,
  };
}

function msg(patch: Partial<AgentMessage> = {}): AgentMessage {
  return { teamId: "T1", channel: "C900", user: "UANA", text: "the login page 500s", ts: "1731400000.000100", mention: false, topLevel: true, eventId: "Ev1", ...patch };
}

function watchWorld() {
  const recorded = new Map<string, string>();
  const started: PendingRun[] = [];
  const deps: WatchDeps = {
    watchers: async (_t, channel) => (channel === "C900" ? [{ automationId: "watch1", allowedAppIds: ["A123"] }, { automationId: "watch2", allowedAppIds: [] }] : []),
    self: async () => ({ userId: "UBOT", botId: "BOURS" }),
    candidates: async (ids) =>
      ids.map((id) => candidate({ automationId: id, ...(id === "watch2" && { target: { kind: "mission", missionId: "m2", watch: { teamId: "T1", channelId: "C900", filterPrompt: "outages", allowedAppIds: [] }, linearTeamIds: [] } }) })),
    // As record_automation_runs: a key once an automation.
    recordRuns: async (runs: RunRecord[]) => {
      const out = new Map<string, { runId: string; queued: boolean }>();
      for (const r of runs) {
        const k = `${r.automationId}:${r.dedupeKey}`;
        if (recorded.has(k)) continue;
        recorded.set(k, `run-${recorded.size + 1}`);
        out.set(`${r.automationId}:${r.projectId}`, { runId: recorded.get(k)!, queued: false });
      }
      return out;
    },
    startRun: async (run) => {
      started.push(run);
    },
    name: async () => "Ana",
    permalink: async () => null,
  };
  return { deps, started, recorded };
}

test("a watch hears new messages in its channel: not threads, mentions, DMs or empty ones", () => {
  assert.equal(watchable(msg()), true);
  assert.equal(watchable(msg({ threadTs: "1731300000.000100" })), false);
  assert.equal(watchable(msg({ mention: true })), false);
  assert.equal(watchable(msg({ channel: "D1", channelType: "im" })), false);
  assert.equal(watchable(msg({ text: "   " })), false);
});

test("apps are heard only from allowed app ids; a person by every watch", () => {
  const watchers = [{ automationId: "a", allowedAppIds: ["A123"] }, { automationId: "b", allowedAppIds: [] }];
  assert.deepEqual(hearing(msg(), watchers).map((w) => w.automationId), ["a", "b"]);
  assert.deepEqual(hearing(msg({ botId: "B9", appId: "A123" }), watchers).map((w) => w.automationId), ["a"]);
  assert.deepEqual(hearing(msg({ botId: "B9", appId: "A999" }), watchers), []);
  assert.deepEqual(hearing(msg({ botId: "B9", appId: null }), watchers), []);
});

test("one message is one run a watch, however often it's processed; each watch its own", async () => {
  const w = watchWorld();
  assert.equal(await processWatchedMessage(msg(), w.deps), 2);
  assert.equal(await processWatchedMessage(msg(), w.deps), 0, "a retry records nothing new");
  assert.deepEqual(w.started.map((r) => [r.candidate.automationId, (r.event as { ts: string }).ts]), [["watch1", "1731400000.000100"], ["watch2", "1731400000.000100"]]);
  assert.equal(w.started[0].event.trigger, "slack.message");
  assert.equal((w.started[0].event as { author: string }).author, "Ana");
});

test("Outrunner's own messages never loop back into a watch, whatever its allowlist says", async () => {
  const w = watchWorld();
  // A Mission's root post in a channel it also watches: our bot's.
  assert.equal(await processWatchedMessage(msg({ user: "UBOT", botId: "BOURS", appId: "A123" }), w.deps), 0);
  assert.equal(await processWatchedMessage(msg({ user: "BOURS", botId: "BOURS", appId: "A123" }), w.deps), 0);
  assert.equal(w.started.length, 0);
  // Another app, allowed: heard by the watch that allows it only.
  assert.equal(await processWatchedMessage(msg({ user: "B9", botId: "B9", appId: "A123", ts: "1731400001.000100" }), w.deps), 1);
  assert.equal(w.started[0].candidate.automationId, "watch1");
});

test("the endpoint saves a watched message before it answers, and a bound channel's mention is never a watch's", async () => {
  const saved: string[] = [];
  const deps: InboundDeps = {
    binding: async (_t, channel) => (channel === "C900" ? ({ missionId: "m-bound" } as never) : null),
    thread: async () => null,
    watched: (m) => watchEligible(m, watchWorld().deps),
    save: async (id) => {
      saved.push(id);
      return true;
    },
    claim: async () => null,
    handle: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
  };
  assert.equal(await acceptInbound("Ev1", msg(), deps), "saved");
  assert.equal(await acceptInbound("Ev2", msg({ botId: "B9", appId: "A999", eventId: "Ev2" }), deps), "not_mission", "an app no watch allows");
  assert.equal(await acceptInbound("Ev3", msg({ channel: "C111", eventId: "Ev3" }), deps), "not_mission");
  // A mention in the watched channel: the bound route's (saved, as a
  // mention), and not watchable, so no watch runs it too.
  assert.equal(await acceptInbound("Ev4", msg({ mention: true, eventId: "Ev4" }), deps), "saved");
  assert.equal(watchable(msg({ mention: true })), false);
  assert.deepEqual(saved, ["Ev1", "Ev4"]);
});

// Webhooks.

const headers = (h: Record<string, string>) => new Headers(h);

test("a Mission's webhook needs a delivery key; the same key with another body is a conflict", () => {
  const raw = JSON.stringify({ alert: "disk full" });
  const missing = checkMissionWebhook({ headers: headers({}), raw, secret: null });
  assert.ok(!missing.ok && missing.status === 400);
  const first = checkMissionWebhook({ headers: headers({ "idempotency-key": "delivery-1" }), raw, secret: null });
  assert.ok(first.ok && first.key === "webhook:key:delivery-1" && first.payloadHash === payloadHashOf(raw));
  const viaDelivery = checkMissionWebhook({ headers: headers({ "x-delivery-id": "d-9" }), raw, secret: null });
  assert.ok(viaDelivery.ok && viaDelivery.key === "webhook:key:d-9");
  assert.equal(sameDelivery([{ payloadHash: payloadHashOf(raw) }], payloadHashOf(raw)), true);
  assert.equal(sameDelivery([{ payloadHash: payloadHashOf(raw) }], payloadHashOf("{}")), false);
  assert.ok(!checkMissionWebhook({ headers: headers({ "idempotency-key": "x".repeat(201) }), raw, secret: null }).ok);
});

test("with a signing secret, the body must be signed with it", () => {
  const raw = '{"a":1}';
  const secret = "s3cret-s3cret-s3cret";
  const good = checkMissionWebhook({ headers: headers({ "idempotency-key": "k", "x-outrunner-signature": signatureOf(raw, secret) }), raw, secret });
  assert.equal(good.ok, true);
  for (const sig of ["", "sha256=00", signatureOf(raw, "another-secret-entirely"), signatureOf('{"a":2}', secret)]) {
    const bad = checkMissionWebhook({ headers: headers({ "idempotency-key": "k", ...(sig && { "x-outrunner-signature": sig }) }), raw, secret });
    assert.ok(!bad.ok && bad.status === 401, sig);
    // The error names the header, never the secret or the body.
    assert.ok(!bad.ok && !bad.error.includes(secret) && !bad.error.includes(raw));
  }
});

// Schedules.

const daily: Schedule = { kind: "weekly", timezone: "America/New_York", days: [0, 1, 2, 3, 4, 5, 6], time: "01:30" } as Schedule;

test("an occurrence's identity: the same through a DST repeat and an edit that doesn't move it", () => {
  // 2026-11-01: New York's clocks go back at 02:00, so 01:30 happens twice.
  const first = "2026-11-01T05:30:00.000Z";
  const second = "2026-11-01T06:30:00.000Z";
  assert.equal(occurrenceKey("s1", daily, first), occurrenceKey("s1", daily, second));
  assert.match(occurrenceKey("s1", daily, first), /^occurrence:s1:[0-9a-f]{8}:2026-11-01T01:30$/);
  // Saved again unchanged: the same revision. Moved: a new one.
  assert.equal(scheduleRevision({ ...daily }), scheduleRevision(daily));
  assert.notEqual(scheduleRevision({ ...daily, time: "02:30" } as Schedule), scheduleRevision(daily));
  assert.notEqual(occurrenceKey("s2", daily, first), occurrenceKey("s1", daily, first));
});

test("missed occurrences during an outage are counted, to fold into the one run", () => {
  const due = Date.parse("2026-11-10T06:30:00Z");
  assert.equal(missedSince(daily, due, Date.parse("2026-11-10T07:00:00Z")), 0);
  assert.equal(missedSince(daily, due, Date.parse("2026-11-13T07:00:00Z")), 3);
  assert.ok(nextRun(daily, due) !== null);
});

test("the tick: a Mission's schedule runs once, keyed by its occurrence, carrying what it missed; a session's as before", async () => {
  const recorded: RunRecord[] = [];
  const now = new Date("2026-11-13T07:00:00Z");
  const runs = await planScheduledRuns(now, {
    dueSchedules: async () => [{ scheduleId: "s1", automationId: "a1", schedule: daily, dueAt: "2026-11-10T06:30:00.000Z" }],
    automationCandidates: async () => [
      candidate({ automationId: "a1", triggers: ["schedule"], projectId: "p1" }),
      candidate({ automationId: "a1", triggers: ["schedule"], projectId: "p2", target: { kind: "session" } }),
    ],
    recordRuns: async (records) => {
      recorded.push(...records);
      return new Map(records.map((r, i) => [`${r.automationId}:${r.projectId}`, { runId: `r${i}`, queued: false }]));
    },
    advanceSchedule: async () => true,
  });
  assert.equal(runs.length, 2);
  const mission = recorded.find((r) => r.projectId === "p1")!;
  const session = recorded.find((r) => r.projectId === "p2")!;
  assert.match(mission.dedupeKey, /^occurrence:s1:/);
  assert.equal((mission.event as ScheduleEvent).missed, 3);
  assert.equal(session.dedupeKey, "schedule:2026-11-10T06:30:00.000Z");
  assert.equal((session.event as ScheduleEvent).missed, undefined);
});
