import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ORG_SETTINGS,
  PERSONAL_SETTINGS,
  SETTINGS_REDIRECTS,
} from "@/lib/settings-navigation";

test("settings have exactly the approved personal and organization orders", () => {
  assert.deepEqual(
    PERSONAL_SETTINGS.map((s) => s[1]),
    [
      "Profile",
      "Preferences",
      "Coding agents",
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
test("old credential/auth, membership, and billing destinations keep compatible scoped destinations", () => {
  const redirects = new Map<string, string>(SETTINGS_REDIRECTS);
  assert.equal(redirects.get("/settings/providers"), "/settings/coding-agents");
  assert.equal(
    redirects.get("/settings/org/keys"),
    "/settings/org/coding-agents",
  );
  assert.equal(redirects.get("/settings/billing"), "/settings/org/billing");
  assert.equal(
    redirects.get("/settings/org/access"),
    "/settings/org/members?tab=roles",
  );
  assert.equal(redirects.get("/settings/sandbox"), "/settings/profile");
});
