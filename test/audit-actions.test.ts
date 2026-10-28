import assert from "node:assert/strict";
import { test } from "node:test";

import { actorLabel, auditGroup, describeAudit } from "@/lib/audit/actions";

const event = (action: string, resourceLabel: string | null, details: Record<string, unknown> = {}) => ({
  action,
  resourceLabel,
  details,
});

test("each kind of event reads as what happened", () => {
  assert.equal(describeAudit(event("member.invited", "ada@acme.dev", { role: "admin" })), "invited ada@acme.dev as admin");
  assert.equal(describeAudit(event("member.role_changed", "ada", { role: "admin" })), "made ada an admin");
  assert.equal(describeAudit(event("member.roles_set", "ada", { roles: [] })), "took ada's roles away");
  assert.equal(
    describeAudit(event("access.changed", null, { role: "Backend", project: "acme/api", level: "write" })),
    "gave Backend write access to acme/api",
  );
  assert.equal(
    describeAudit(event("access.changed", null, { role: null, project: null, level: null })),
    "took Everyone's access to all projects away",
  );
  assert.equal(describeAudit(event("key.saved", "OpenRouter", { hint: "ab12" })), "saved the org's OpenRouter key (…ab12)");
  assert.equal(
    describeAudit(event("usage.changed", null, { limitPercent: 80, alertThresholds: [50, 100] })),
    "set the usage limit to 80%, alerts at 50%, 100%",
  );
  assert.equal(describeAudit(event("billing.plan_changed", "Pro", { status: "past_due" })), "saw the plan become Pro (past_due)");
  // One this release doesn't know reads as its name, not nothing.
  assert.equal(describeAudit(event("thing.happened", null)), "thing.happened");
});

test("events group by what they're about", () => {
  assert.equal(auditGroup("invite.revoked"), "members");
  assert.equal(auditGroup("access.changed"), "access");
  assert.equal(auditGroup("usage.changed"), "settings");
  assert.equal(auditGroup("github.uninstalled"), "github");
});

test("the actor is named by login, else name or email; Outrunner for its own", () => {
  assert.equal(actorLabel("system"), "Outrunner");
  assert.equal(actorLabel({ id: "u", githubLogin: "ada", name: "Ada", email: null }), "ada");
  assert.equal(actorLabel({ id: "u", githubLogin: "", name: "", email: "ada@acme.dev" }), "ada@acme.dev");
});
