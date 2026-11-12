import assert from "node:assert/strict";
import { test } from "node:test";

import { deploymentCard } from "@/lib/integrations/card";

const base = { configureHref: "/settings/org/linear", setupDoc: "docs/linear-app.md" };

test("connected: Configure, whoever's looking and whatever the deployment has", () => {
  for (const admin of [true, false]) {
    for (const installHref of ["/settings/org/linear", null]) {
      assert.deepEqual(deploymentCard({ ...base, connected: true, admin, installHref }), { action: { kind: "configure", href: "/settings/org/linear" }, note: null });
    }
  }
});

test("not connected, on a deployment that has the app: an admin installs, a member sees nothing to do", () => {
  assert.deepEqual(deploymentCard({ ...base, connected: false, admin: true, installHref: "/settings/org/linear" }).action, { kind: "install", href: "/settings/org/linear" });
  assert.deepEqual(deploymentCard({ ...base, connected: false, admin: false, installHref: "/settings/org/linear" }), { action: null, note: null });
  assert.deepEqual(deploymentCard({ ...base, connected: false, admin: true, installHref: "https://github.com/apps/x", external: true }).action, { kind: "install", href: "https://github.com/apps/x", external: true });
  // Slack decides for itself who may add it.
  assert.deepEqual(deploymentCard({ ...base, connected: false, admin: false, installHref: "https://slack.com/x", external: true, installableByMembers: true }).action?.kind, "install");
});

test("not connected, on a deployment without the app: an admin is told why, a member sees nothing", () => {
  const unset = deploymentCard({ ...base, connected: false, admin: true, installHref: null });
  assert.equal(unset.action, null);
  assert.match(unset.note ?? "", /Not set up on this deployment yet/);
  assert.match(unset.note ?? "", /docs\/linear-app\.md/);
  assert.deepEqual(deploymentCard({ ...base, connected: false, admin: false, installHref: null }), { action: null, note: null });
});
