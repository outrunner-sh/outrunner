import assert from "node:assert/strict";
import { test } from "node:test";

import {
  digestDue,
  digestText,
  isTimeZone,
  localTime,
  nudgeText,
  parseClassification,
  parseVerdict,
  PROACTIVE_ACTIONS,
  sendBackPrompt,
  verdictBlocks,
  watchOffer,
} from "@/lib/slack/proactive-text";

test("local time follows the channel's time zone", () => {
  const now = new Date("2026-11-02T03:40:00Z"); // a Monday
  assert.deepEqual(localTime(now, "Asia/Kolkata"), { date: "2026-11-02", hour: 9, weekday: 1 });
  assert.deepEqual(localTime(now, "America/New_York"), { date: "2026-11-01", hour: 22, weekday: 0 });
  assert.equal(isTimeZone("Asia/Kolkata"), true);
  assert.equal(isTimeZone("Mars/Olympus"), false);
});

test("a digest goes out in its hour, once a day, and weekly ones on Mondays", () => {
  const now = new Date("2026-11-02T03:40:00Z"); // 09:10 Monday in Kolkata
  const daily = { digest: "daily" as const, hour: 9, tz: "Asia/Kolkata", lastSentOn: null };
  assert.equal(digestDue(daily, now), "2026-11-02");
  assert.equal(digestDue({ ...daily, lastSentOn: "2026-11-02" }, now), null);
  assert.equal(digestDue({ ...daily, hour: 10 }, now), null);
  assert.equal(digestDue({ ...daily, digest: "weekly" }, now), "2026-11-02");
  assert.equal(digestDue({ ...daily, digest: "weekly" }, new Date("2026-11-03T03:40:00Z")), null);
  assert.equal(digestDue({ ...daily, digest: null }, now), null);
});

test("the digest lists what shipped, what's stuck and what waits; nothing to say is null", () => {
  const empty = { orgName: "Acme", period: "daily" as const, shipped: [], inProgress: [], waiting: [], stuck: [] };
  assert.equal(digestText(empty), null);
  const text = digestText({
    ...empty,
    shipped: [{ repo: "acme/web", number: 7, title: "Fix <login>", url: "https://gh/7" }],
    stuck: [{ key: "OR-3", title: "Dark mode", url: "https://app/3", days: 4 }],
    waiting: [{ key: "OR-9", title: "Slow sidebar", url: "https://app/9", days: 2 }],
  });
  assert.match(text ?? "", /^\*Acme: daily digest\*/);
  assert.match(text ?? "", /\*Shipped since yesterday\* \(1\)\n• <https:\/\/gh\/7\|#7 Fix &lt;login&gt;> · acme\/web/);
  assert.match(text ?? "", /\*Stuck: in progress with no pull request\* \(1\)\n• <https:\/\/app\/3\|OR-3> Dark mode · 4d/);
  assert.match(text ?? "", /\*Waiting in triage\* \(1\)/);
  assert.doesNotMatch(text ?? "", /In progress/);
  assert.match(nudgeText({ key: "OR-9", title: "Slow", url: "https://app/9", days: 1 }), /has waited in triage for a day/);
});

test("the validator's verdict is read from its comment", () => {
  assert.equal(parseVerdict("Verdict: FAIL (any criterion not met)\n- ..."), "FAIL");
  assert.equal(parseVerdict("**Verdict:** PASS\n\nAll met."), "PASS");
  assert.equal(parseVerdict("Some intro\nVerdict: PARTIAL"), "PARTIAL");
  assert.equal(parseVerdict("Score: 4/5"), null);
  assert.equal(parseVerdict("The verdict is unclear"), null);
});

test("a FAIL offers to send the work back; a PASS just reports", () => {
  const base = { itemKey: "OR-4", url: "https://gh/9", excerpt: "Verdict: FAIL", conversationId: "c1" };
  const fail = verdictBlocks({ ...base, verdict: "FAIL" });
  const ids = (fail.find((b) => b.type === "actions")?.elements as { action_id: string }[]).map((e) => e.action_id);
  assert.deepEqual(ids, [PROACTIVE_ACTIONS.sendBack, PROACTIVE_ACTIONS.leave]);
  assert.equal(verdictBlocks({ ...base, verdict: "PASS" }).some((b) => b.type === "actions"), false);
  assert.match(sendBackPrompt("OR-4", "Verdict: FAIL\n- criterion 2 not met"), /^The validator checked your pull request for OR-4[\s\S]*criterion 2 not met[\s\S]*push to the same branch/);
});

test("the watch check is strict: anything unclear is nothing to file", () => {
  assert.deepEqual(parseClassification('{"kind":"bug","summary":"Fix checkout on Safari"}'), { kind: "bug", summary: "Fix checkout on Safari" });
  assert.deepEqual(parseClassification('{"kind":"request","summary":""}'), { kind: "none", summary: "" });
  assert.deepEqual(parseClassification('{"kind":"maybe","summary":"x"}'), { kind: "none", summary: "" });
  assert.deepEqual(parseClassification("not json"), { kind: "none", summary: "" });
  const offer = watchOffer({ kind: "bug", summary: "Fix <checkout>" }, "C1|1.2");
  assert.match(JSON.stringify(offer), /a bug report: \*Fix &lt;checkout&gt;\*/);
  assert.match(JSON.stringify(offer), /"value":"C1\|1.2"/);
});
