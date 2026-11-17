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
  assert.equal(describeAudit(event("invite.resent", "ada@acme.dev", { emailed: true })), "emailed ada@acme.dev a new invite link");
  assert.equal(describeAudit(event("invite.resent", "ada@acme.dev", { emailed: false })), "made a new invite link for ada@acme.dev");
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
    describeAudit(event("api_key.created", "CI", { hint: "x9Zq", expiresAt: "2027-02-01T00:00:00.000Z" })),
    "made the API key CI (…x9Zq), until 2027-02-01",
  );
  assert.equal(describeAudit(event("api_key.revoked", "CI", { hint: "x9Zq" })), "revoked the API key CI (…x9Zq)");
  assert.equal(
    describeAudit(event("webhook.changed", null, { url: "https://hooks.acme.dev/outrunner" })),
    "set the API's webhook endpoint to https://hooks.acme.dev/outrunner",
  );
  assert.equal(describeAudit(event("webhook.changed", null, { url: null })), "removed the API's webhook endpoint");
  assert.equal(describeAudit(event("webhook.secret_rotated", null, {})), "rotated the API's webhook signing secret");
  assert.equal(
    describeAudit(event("usage.changed", null, { limitPercent: 80, alertThresholds: [50, 100] })),
    "set the usage limit to 80%, alerts at 50%, 100%",
  );
  assert.equal(
    describeAudit(event("usage.changed", null, { limitUsd: 30, alertThresholds: [100, 150] })),
    "set the usage limit to $30.00, alerts at 100%, 150%",
  );
  assert.equal(describeAudit(event("usage.changed", null, { limitUsd: null, alertThresholds: [] })), "set the usage limit to none, alerts at none");
  assert.equal(describeAudit(event("billing.plan_changed", "Pro", { status: "past_due" })), "saw the plan become Pro (past_due)");
  // One this release doesn't know reads as its name, not nothing.
  assert.equal(describeAudit(event("thing.happened", null)), "thing.happened");
});

test("events group by what they're about", () => {
  assert.equal(auditGroup("invite.revoked"), "members");
  assert.equal(auditGroup("invite.resent"), "members");
  assert.equal(auditGroup("access.changed"), "access");
  assert.equal(auditGroup("usage.changed"), "settings");
  assert.equal(auditGroup("github.uninstalled"), "github");
  assert.equal(auditGroup("api_key.created"), "keys");
});

test("the actor is named by login, else name or email; Outrunner for its own", () => {
  assert.equal(actorLabel("system"), "Outrunner");
  assert.equal(actorLabel({ id: "u", githubLogin: "ada", name: "Ada", email: null }), "ada");
  assert.equal(actorLabel({ id: "u", githubLogin: "", name: "", email: "ada@acme.dev" }), "ada@acme.dev");
});

test("a preview's mode changing and its deletion read as what they let in", () => {
  assert.equal(
    describeAudit(event("preview.made_public", "Web app")),
    "made the preview Web app public: anyone with its link can open it",
  );
  assert.equal(describeAudit(event("preview.made_login", "port 3000")), "made the preview port 3000 sign-in only");
  assert.equal(describeAudit(event("preview.deleted", "Web app")), "deleted the preview Web app");
  assert.equal(auditGroup("preview.made_public"), "access");
});

test("a project's changes read as its history says them, never a value", () => {
  assert.equal(describeAudit(event("project.created", "Web + API")), "made the project Web + API");
  assert.equal(describeAudit(event("project.changed", "Web", { fields: ["hooks", "name"] })), "changed the project Web's hooks, name");
  assert.equal(describeAudit(event("project.secrets_changed", "Web", { set: ["STRIPE_KEY"], removed: ["OLD"] })), "changed the project Web's secrets: set STRIPE_KEY; removed OLD");
  assert.equal(describeAudit(event("project.repos_changed", "Web", { added: "acme/api" })), "added acme/api to the project Web");
  assert.equal(describeAudit(event("project.repos_changed", "Web", { removed: "acme/api" })), "took acme/api out of the project Web");
  assert.equal(describeAudit(event("project.deleted", "Web")), "deleted the project Web");
  assert.equal(auditGroup("project.changed"), "settings");
});
