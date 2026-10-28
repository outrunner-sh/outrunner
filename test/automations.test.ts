import assert from "node:assert/strict";
import { test } from "node:test";

import { appCoverage, parseAutomationInput, PROMPT_MAX, REPOS_MAX } from "@/lib/automations/rules";
import { AUTOMATION_TEMPLATES, automationTemplate } from "@/lib/automations/templates";

const A = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";
const B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const full = {
  name: "  Code   Review ",
  template: "code-review",
  prompt: "  Review it.  ",
  triggers: ["pull_request.synchronize", "pull_request.opened", "pull_request.opened"],
  projectIds: [A, B, A],
  enabled: false,
};

test("a whole automation is trimmed, deduplicated and kept in trigger order", () => {
  assert.deepEqual(parseAutomationInput(full, { full: true }), {
    ok: true,
    value: {
      name: "Code Review",
      template: "code-review",
      prompt: "Review it.",
      triggers: ["pull_request.opened", "pull_request.synchronize"],
      projectIds: [A, B],
      enabled: false,
    },
  });
});

test("a new automation is on unless it says otherwise, and needs no template", () => {
  const parsed = parseAutomationInput({ ...full, template: undefined, enabled: undefined }, { full: true });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.enabled, true);
  assert.equal(parsed.value.template, null);
});

test("a change carries only what it sends", () => {
  assert.deepEqual(parseAutomationInput({ enabled: true }, { full: false }), { ok: true, value: { enabled: true } });
  assert.deepEqual(parseAutomationInput({}, { full: false }), { ok: true, value: {} });
});

test("what can't be saved is refused, saying why", () => {
  const refused: [string, unknown][] = [
    ["no body", null],
    ["no name", { ...full, name: "   " }],
    ["long name", { ...full, name: "x".repeat(81) }],
    ["no prompt", { ...full, prompt: " " }],
    ["long prompt", { ...full, prompt: "x".repeat(PROMPT_MAX + 1) }],
    ["no triggers", { ...full, triggers: [] }],
    ["unknown trigger", { ...full, triggers: ["push"] }],
    ["no repositories", { ...full, projectIds: [] }],
    ["not a uuid", { ...full, projectIds: ["acme/web"] }],
    [
      "too many repositories",
      { ...full, projectIds: Array.from({ length: REPOS_MAX + 1 }, (_, i) => `${A.slice(0, -2)}${String(i).padStart(2, "0")}`) },
    ],
    ["enabled not a boolean", { ...full, enabled: "yes" }],
    ["template not a string", { ...full, template: 3 }],
  ];
  for (const [what, body] of refused) {
    const parsed = parseAutomationInput(body, { full: true });
    assert.equal(parsed.ok, false, what);
    if (!parsed.ok) assert.ok(parsed.error.length > 0, what);
  }
});

const all = { installationId: 1, accountLogin: "Acme", repositorySelection: "all" as const, suspendedAt: null };
const some = { installationId: 2, accountLogin: "beta", repositorySelection: "selected" as const, suspendedAt: null };

test("the app covers an account's repositories when installed on all of them", () => {
  const coverage = appCoverage(["acme/web", "other/api"], [all], new Map());
  assert.equal(coverage.get("acme/web"), "installed");
  assert.equal(coverage.get("other/api"), "not_installed");
});

test("on selected repositories, only those listed; unknown when the list couldn't be read", () => {
  const listed = appCoverage(["beta/one", "beta/two"], [some], new Map([[2, { names: new Set(["beta/one"]), complete: true }]]));
  assert.equal(listed.get("beta/one"), "installed");
  assert.equal(listed.get("beta/two"), "not_installed");
  assert.equal(appCoverage(["beta/one"], [some], new Map()).get("beta/one"), "unknown");
  const partial = new Map([[2, { names: new Set(["beta/one"]), complete: false }]]);
  assert.equal(appCoverage(["beta/two"], [some], partial).get("beta/two"), "unknown");
});

test("a suspended installation is said so, unless another one covers the repository", () => {
  const suspended = { ...all, suspendedAt: "2026-10-27T10:00:00Z" };
  assert.equal(appCoverage(["acme/web"], [suspended], new Map()).get("acme/web"), "suspended");
  assert.equal(
    appCoverage(["acme/web"], [suspended, { ...all, installationId: 3 }], new Map()).get("acme/web"),
    "installed",
  );
});

test("the Code Review template runs on opened PRs and new commits, and parses as an automation", () => {
  const template = automationTemplate("code-review");
  assert.ok(template);
  assert.deepEqual(template.triggers, ["pull_request.opened", "pull_request.synchronize"]);
  assert.match(template.prompt, /X\/5/);
  assert.equal(automationTemplate("nope"), null);
  for (const t of AUTOMATION_TEMPLATES) {
    const parsed = parseAutomationInput(
      { name: t.name, template: t.id, prompt: t.prompt, triggers: t.triggers, projectIds: [A] },
      { full: true },
    );
    assert.ok(parsed.ok, t.id);
  }
});
