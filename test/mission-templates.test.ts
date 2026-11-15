import assert from "node:assert/strict";
import { test } from "node:test";

import { MISSION_TRIGGERS, NAME_MAX, parseAutomationInput, PROMPT_MAX } from "@/lib/automations/rules";
import { nextRun } from "@/lib/automations/schedule";
import { MISSION_ICONS } from "@/lib/missions/icons";
import { buildHirePlan, DEFAULT_BUDGET, MISSION_NAME_MAX, MISSION_TEMPLATES, missionTemplate } from "@/lib/missions/templates";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-15T12:00:00Z");

/** A trigger as POST /api/missions/[id]/triggers parses it: the body, its
 *  destination the Mission, its repository the project. */
const parseAsRoute = (body: object) =>
  parseAutomationInput({ ...body, target: { kind: "mission", missionId: MISSION }, projectIds: [PROJECT] }, { full: true, now: NOW });

test("three templates: On-call, CI fixer, Release manager", () => {
  assert.deepEqual(
    MISSION_TEMPLATES.map((t) => [t.id, t.name]),
    [
      ["on-call", "On-call"],
      ["ci-fixer", "CI fixer"],
      ["release-manager", "Release manager"],
    ],
  );
  assert.equal(missionTemplate("ci-fixer")?.name, "CI fixer");
  assert.equal(missionTemplate("nope"), null);
});

test("each template has a name, one-line description, an icon of the set and instructions", () => {
  for (const t of MISSION_TEMPLATES) {
    assert.ok(t.name.length > 0 && t.name.length <= MISSION_NAME_MAX, t.id);
    assert.ok(t.description.length > 0 && !t.description.includes("\n"), t.id);
    assert.ok(MISSION_ICONS.some((i) => i.key === t.icon), `${t.id}: ${t.icon}`);
    assert.ok(t.prompt.trim().length > 0, t.id);
    // Its first line is a heading of its name: if the rename fails, that names it.
    assert.equal(t.prompt.split("\n")[0], `# ${t.name}`);
  }
});

test("every template's default budgets are $100 a day and $1000 a week", () => {
  assert.deepEqual(DEFAULT_BUDGET, { dailyUsd: 100, weeklyUsd: 1000 });
  for (const t of MISSION_TEMPLATES) assert.deepEqual(t.budget, { dailyUsd: 100, weeklyUsd: 1000 }, t.id);
});

test("On-call has no default triggers and suggests a Slack channel; the others don't", () => {
  const onCall = missionTemplate("on-call")!;
  assert.deepEqual(onCall.triggers("UTC"), []);
  assert.equal(onCall.suggestsSlack, true);
  assert.equal(missionTemplate("ci-fixer")!.suggestsSlack, false);
  assert.equal(missionTemplate("release-manager")!.suggestsSlack, false);
});

test("CI fixer's default trigger is a webhook, valid as the triggers route parses it", () => {
  const [trigger, ...rest] = missionTemplate("ci-fixer")!.triggers("Europe/Berlin");
  assert.equal(rest.length, 0);
  assert.deepEqual(trigger.triggers, ["webhook"]);
  const parsed = parseAsRoute(trigger);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.value.triggers, ["webhook"]);
  assert.deepEqual(parsed.value.schedules, []);
  assert.equal(parsed.value.target?.kind, "mission");
  assert.equal(parsed.value.enabled, true);
});

test("Release manager's default trigger is weekly, Mondays 09:00 in the hirer's zone, valid as the route parses it", () => {
  const [trigger, ...rest] = missionTemplate("release-manager")!.triggers("America/New_York");
  assert.equal(rest.length, 0);
  const parsed = parseAsRoute(trigger);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.value.triggers, ["schedule"]);
  assert.deepEqual(parsed.value.schedules, [{ kind: "weekly", timezone: "America/New_York", days: [1], time: "09:00" }]);
  // Monday Nov 16, 09:00 EST.
  assert.equal(new Date(nextRun(parsed.value.schedules[0], NOW)!).toISOString(), "2026-11-16T14:00:00.000Z");
});

test("every default trigger is a Mission's kind, within the route's limits, in any zone", () => {
  for (const zone of ["UTC", "Asia/Kolkata", "Pacific/Auckland"]) {
    for (const t of MISSION_TEMPLATES) {
      for (const trigger of t.triggers(zone)) {
        assert.ok(trigger.triggers.every((x) => (MISSION_TRIGGERS as readonly string[]).includes(x)), t.id);
        assert.ok(trigger.name.length <= NAME_MAX && trigger.prompt.length <= PROMPT_MAX, t.id);
        const parsed = parseAsRoute(trigger);
        assert.ok(parsed.ok, `${t.id} in ${zone}: ${parsed.ok ? "" : parsed.error}`);
      }
    }
  }
});

test("buildHirePlan: the template's defaults, or the hirer's name and instructions", () => {
  const template = missionTemplate("release-manager")!;
  const plan = buildHirePlan(template, { projectId: PROJECT, timezone: "Asia/Kolkata" });
  assert.deepEqual(plan.create, { projectId: PROJECT, prompt: template.prompt });
  assert.deepEqual(plan.profile, { title: "Release manager", icon: "flag" });
  assert.deepEqual(plan.budget, { dailyUsd: 100, weeklyUsd: 1000 });
  assert.equal(plan.triggers[0].schedules[0].timezone, "Asia/Kolkata");
  assert.equal(plan.suggestsSlack, false);

  const edited = buildHirePlan(template, { projectId: PROJECT, timezone: "UTC", name: "  Ship   train ", prompt: "  Do releases.  " });
  assert.deepEqual(edited.profile, { title: "Ship train", icon: "flag" });
  assert.equal(edited.create.prompt, "Do releases.");

  const blank = buildHirePlan(template, { projectId: PROJECT, timezone: "UTC", name: "   ", prompt: "\n" });
  assert.equal(blank.profile.title, "Release manager");
  assert.equal(blank.create.prompt, template.prompt);

  // A plan's budget is its own: changing it leaves the template's be.
  plan.budget.dailyUsd = 5;
  assert.equal(template.budget.dailyUsd, 100);
});
