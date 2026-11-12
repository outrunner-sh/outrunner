import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ORG_SETTINGS,
  PERSONAL_SETTINGS,
  SETTINGS_REDIRECTS,
  settingsNavigationTitle,
} from "@/lib/settings-navigation";

test("settings have exactly the approved personal and organization orders", () => {
  assert.deepEqual(
    PERSONAL_SETTINGS.map((s) => s[1]),
    [
      "Profile",
      "Preferences",
      "Coding agents",
      "Sandbox",
      "Connections",
      "Usage",
      "Developer",
    ],
  );
  assert.deepEqual(
    ORG_SETTINGS.map((s) => s[1]),
    [
      "General",
      "Members & access",
      "Coding agents",
      "Integrations",
      "Usage & limits",
      "Billing",
      "Developer",
      "Audit log",
    ],
  );
});

test("breadcrumbs use the canonical personal and organization navigation labels", () => {
  for (const [path, label] of PERSONAL_SETTINGS)
    assert.equal(settingsNavigationTitle(`/settings/${path}`), label);
  for (const [path, label] of ORG_SETTINGS)
    assert.equal(settingsNavigationTitle(`/settings/org${path}`), label);
  assert.equal(settingsNavigationTitle("/settings/org/github"), "GitHub");
  assert.equal(settingsNavigationTitle("/settings/org/slack"), "Slack");
  assert.equal(settingsNavigationTitle("/settings/org/linear"), "Linear");
  assert.equal(settingsNavigationTitle("/settings/org/integrations/linear"), "Integrations");
  assert.equal(settingsNavigationTitle("/settings/unknown"), "Settings");
});
test("old credential/auth, membership, and billing destinations keep compatible scoped destinations", () => {
  const redirects = new Map<string, string>(SETTINGS_REDIRECTS);
  // Provider aliases resolve at request time to preserve #328's active-org account links.
  assert.equal(redirects.has("/settings/providers"), false);
  assert.equal(
    redirects.get("/settings/org/keys"),
    "/settings/org/coding-agents",
  );
  assert.equal(redirects.get("/settings/billing"), "/settings/org/billing");
  assert.equal(
    redirects.get("/settings/org/access"),
    "/settings/org/members?tab=roles",
  );
  assert.equal(redirects.has("/settings/sandbox"), false);
});
