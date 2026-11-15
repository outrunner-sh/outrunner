import assert from "node:assert/strict";
import { test } from "node:test";

import { hireMission, usd } from "@/lib/missions/hire";
import { buildHirePlan, missionTemplate } from "@/lib/missions/templates";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";

type Call = { method: string; url: string; body: unknown };
type Answer = { status: number; body?: unknown } | "throw";

/** A fetch answering by "METHOD url", recording each call in order. */
function fakeFetch(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: JSON.parse(String(init.body)) });
    const answer = answers[`${method} ${url}`] ?? { status: 200, body: { ok: true } };
    if (answer === "throw") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetcher };
}

const created: Record<string, Answer> = {
  "POST /api/missions": { status: 201, body: { workspace: { id: MISSION } } },
  [`POST /api/missions/${MISSION}/triggers`]: { status: 201, body: { id: "auto-1", approved: true } },
};

const plan = (id: string) => buildHirePlan(missionTemplate(id)!, { projectId: PROJECT, timezone: "Europe/Berlin" });

test("hiring makes the Mission, then names it, then each trigger, then its budgets", async () => {
  const { calls, fetcher } = fakeFetch(created);
  const outcome = await hireMission(plan("release-manager"), fetcher);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ["POST /api/missions", `PATCH /api/missions/${MISSION}`, `POST /api/missions/${MISSION}/triggers`, `PUT /api/missions/${MISSION}/budget`],
  );
  assert.deepEqual(calls[0].body, { projectId: PROJECT, prompt: missionTemplate("release-manager")!.prompt });
  assert.deepEqual(calls[1].body, { title: "Release manager", icon: "flag" });
  assert.deepEqual((calls[2].body as { schedules: unknown }).schedules, [{ kind: "weekly", timezone: "Europe/Berlin", days: [1], time: "09:00" }]);
  assert.deepEqual(calls[3].body, { dailyUsd: 100, weeklyUsd: 1000 });
  assert.equal(outcome.missionId, MISSION);
  assert.equal(outcome.failed, false);
  assert.deepEqual(
    outcome.steps.map((s) => [s.kind, s.status]),
    [
      ["create", "done"],
      ["profile", "done"],
      ["trigger", "done"],
      ["budget", "done"],
    ],
  );
  assert.equal(outcome.steps[2].id, "auto-1");
});

test("On-call makes no trigger", async () => {
  const { calls, fetcher } = fakeFetch(created);
  const outcome = await hireMission(plan("on-call"), fetcher);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["POST", "PATCH", "PUT"],
  );
  assert.equal(outcome.failed, false);
});

test("a Mission that isn't made stops the hire there, with why", async () => {
  const { calls, fetcher } = fakeFetch({ "POST /api/missions": { status: 400, body: { error: "Missions run on Claude Code." } } });
  const outcome = await hireMission(plan("ci-fixer"), fetcher);
  assert.equal(calls.length, 1);
  assert.equal(outcome.missionId, null);
  assert.equal(outcome.failed, true);
  assert.deepEqual(outcome.steps, [{ kind: "create", label: "Start the Mission", status: "failed", detail: "Missions run on Claude Code." }]);
});

test("a create answered 200 without a Mission is a failed create", async () => {
  const { fetcher } = fakeFetch({ "POST /api/missions": { status: 200, body: {} } });
  const outcome = await hireMission(plan("ci-fixer"), fetcher);
  assert.equal(outcome.missionId, null);
  assert.equal(outcome.steps[0].status, "failed");
});

test("a trigger that fails keeps the Mission, says which step failed, and the rest still run", async () => {
  const { calls, fetcher } = fakeFetch({
    ...created,
    [`POST /api/missions/${MISSION}/triggers`]: { status: 403, body: { error: "You need write on this project." } },
  });
  const outcome = await hireMission(plan("ci-fixer"), fetcher);
  assert.equal(outcome.missionId, MISSION);
  assert.equal(outcome.failed, true);
  assert.equal(calls.at(-1)?.method, "PUT");
  const trigger = outcome.steps.find((s) => s.kind === "trigger")!;
  assert.deepEqual(trigger, { kind: "trigger", label: "Add trigger: CI failure", status: "failed", detail: "You need write on this project." });
  assert.equal(outcome.steps.find((s) => s.kind === "budget")?.status, "done");
});

test("a budget call that fails is reported; the Mission is kept", async () => {
  const { fetcher } = fakeFetch({ ...created, [`PUT /api/missions/${MISSION}/budget`]: { status: 500, body: { error: "Database down." } } });
  const outcome = await hireMission(plan("release-manager"), fetcher);
  assert.equal(outcome.missionId, MISSION);
  assert.equal(outcome.failed, true);
  assert.deepEqual(outcome.steps.at(-1), {
    kind: "budget",
    label: "Set budgets: $100/day, $1,000/week",
    status: "failed",
    detail: "Database down.",
  });
});

test("budgets answered 404 (not in this deployment) are skipped and logged, not a failed hire", async () => {
  const logged: string[] = [];
  const { fetcher } = fakeFetch({ ...created, [`PUT /api/missions/${MISSION}/budget`]: { status: 404, body: { error: "Not found" } } });
  const outcome = await hireMission(plan("release-manager"), fetcher, (m) => logged.push(m));
  assert.equal(outcome.failed, false);
  assert.equal(outcome.steps.at(-1)?.status, "skipped");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /404/);
});

test("a rename that fails, or a network error, is a failed step with a reason", async () => {
  const { fetcher } = fakeFetch({ ...created, [`PATCH /api/missions/${MISSION}`]: "throw", [`PUT /api/missions/${MISSION}/budget`]: "throw" });
  const outcome = await hireMission(plan("on-call"), fetcher);
  assert.equal(outcome.missionId, MISSION);
  assert.deepEqual(
    outcome.steps.map((s) => [s.kind, s.status, s.detail]),
    [
      ["create", "done", undefined],
      ["profile", "failed", "Couldn't reach Outrunner."],
      ["budget", "failed", "Couldn't reach Outrunner."],
    ],
  );
});

test("usd: dollars with thousands, or no limit", () => {
  assert.equal(usd(100), "$100");
  assert.equal(usd(1000), "$1,000");
  assert.equal(usd(null), "no limit");
});
