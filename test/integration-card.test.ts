import assert from "node:assert/strict";
import { test } from "node:test";

import { deploymentCard } from "@/lib/integrations/card";

const base = { configureHref: "/settings/org/linear" };

test("connected: Configure, whoever's looking and whatever the deployment has", () => {
  for (const admin of [true, false]) {
    for (const installHref of ["/settings/org/linear", null]) {
      assert.deepEqual(deploymentCard({ ...base, connected: true, admin, installHref }), { action: { kind: "configure", href: "/settings/org/linear" }, note: null });
    }
  }
});

test("not connected, on a deployment that has the app: an admin installs, a member is told who can", () => {
  assert.deepEqual(deploymentCard({ ...base, connected: false, admin: true, installHref: "/settings/org/linear" }), { action: { kind: "install", href: "/settings/org/linear" }, note: null });
  assert.deepEqual(deploymentCard({ ...base, connected: false, admin: false, installHref: "/settings/org/linear" }), { action: null, note: "Ask an admin to connect it." });
  assert.deepEqual(deploymentCard({ ...base, connected: false, admin: true, installHref: "https://github.com/apps/x", external: true }).action, { kind: "install", href: "https://github.com/apps/x", external: true });
  // Slack decides for itself who may add it.
  assert.deepEqual(deploymentCard({ ...base, connected: false, admin: false, installHref: "https://slack.com/x", external: true, installableByMembers: true }), { action: { kind: "install", href: "https://slack.com/x", external: true }, note: null });
});

test("not connected, on a deployment without the app: everyone is told it isn't available", () => {
  for (const admin of [true, false]) {
    assert.deepEqual(deploymentCard({ ...base, connected: false, admin, installHref: null }), { action: null, note: "Not available on this deployment yet." });
  }
});
