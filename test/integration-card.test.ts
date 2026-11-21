import assert from "node:assert/strict";
import { test } from "node:test";

import { deploymentCard, deploymentCards } from "@/lib/integrations/card";

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

// --- The page's wiring

const NONE = { github: false, slack: false, linear: false, jira: false };
const NO_APPS = { github: false, slackInstallUrl: null, linear: false, jira: false };
const ALL_APPS = { github: true, slackInstallUrl: "https://slack.com/oauth/v2/authorize?x", linear: true, jira: true };
const UNAVAILABLE = { action: null, note: "Not available on this deployment yet." };

test("a deployment with no apps: every card says so, to admins and members alike", () => {
  for (const admin of [true, false]) {
    assert.deepEqual(deploymentCards({ admin, apps: NO_APPS, connected: NONE }), { github: UNAVAILABLE, slack: UNAVAILABLE, linear: UNAVAILABLE, jira: UNAVAILABLE });
  }
});

test("a deployment with every app: an admin installs each, where it starts", () => {
  assert.deepEqual(deploymentCards({ admin: true, apps: ALL_APPS, connected: NONE }), {
    github: { action: { kind: "install", href: "/api/github/app/install", external: true }, note: null },
    slack: { action: { kind: "install", href: "https://slack.com/oauth/v2/authorize?x", external: true }, note: null },
    linear: { action: { kind: "install", href: "/settings/org/linear" }, note: null },
    jira: { action: { kind: "install", href: "/settings/org/jira" }, note: null },
  });
});

test("a member, with every app: told to ask an admin, but for Slack, which lets them add it", () => {
  const ask = { action: null, note: "Ask an admin to connect it." };
  assert.deepEqual(deploymentCards({ admin: false, apps: ALL_APPS, connected: NONE }), {
    github: ask,
    slack: { action: { kind: "install", href: "https://slack.com/oauth/v2/authorize?x", external: true }, note: null },
    linear: ask,
    jira: ask,
  });
});

test("connected: Configure on its page, whatever the deployment has now, and only for what's connected", () => {
  for (const apps of [NO_APPS, ALL_APPS]) {
    for (const admin of [true, false]) {
      const cards = deploymentCards({ admin, apps, connected: { github: true, slack: true, linear: true, jira: true } });
      assert.deepEqual(cards, {
        github: { action: { kind: "configure", href: "/settings/org/github" }, note: null },
        slack: { action: { kind: "configure", href: "/settings/org/slack" }, note: null },
        linear: { action: { kind: "configure", href: "/settings/org/linear" }, note: null },
        jira: { action: { kind: "configure", href: "/settings/org/jira" }, note: null },
      });
    }
  }
  const linearOnly = deploymentCards({ admin: true, apps: NO_APPS, connected: { ...NONE, linear: true } });
  assert.deepEqual(linearOnly.linear.action, { kind: "configure", href: "/settings/org/linear" });
  assert.deepEqual(linearOnly.jira, UNAVAILABLE);
});
