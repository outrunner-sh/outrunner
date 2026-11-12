"use client";

import { deploymentCard } from "@/lib/integrations/card";
import { LinearIcon } from "@/components/brand-icons";
import { IntegrationCard } from "@/components/integration-card";
import { SettingsFrame } from "@/components/settings-frame";
import { TrackerSettings } from "@/components/tracker-settings";
import { WorkItemDetail } from "@/components/triage/work-item-detail";
import type { SettingsRule, SettingsTracker } from "@/lib/trackers/org-settings";
import type { TriageItem } from "@/lib/triage/work-items";

const PROJECTS = [
  { id: "11111111-1111-4111-8111-111111111111", fullName: "acme/web" },
  { id: "22222222-2222-4222-8222-222222222222", fullName: "acme/api" },
];

function rule(over: Partial<SettingsRule>): SettingsRule {
  return {
    id: "rule-1",
    scopeId: "scope-1",
    position: 0,
    projectId: PROJECTS[0].id,
    setBy: "admin",
    enabled: true,
    labels: [],
    states: [],
    priorities: [],
    issueTypes: [],
    assignees: [],
    stopped: false,
    ...over,
  };
}

function tracker(state: string): SettingsTracker {
  return {
    id: "install-1",
    provider: "linear",
    externalId: "lin-org",
    siteUrl: "https://linear.app/acme",
    name: "Acme",
    appUserId: "app-user",
    disconnected: state === "disconnected",
    connectedAs: null,
    webhookId: null,
    webhookExpiresAt: null,
    webhookProblem: false,
    scopes: [
      {
        id: "scope-1",
        installationId: "install-1",
        orgId: "org-1",
        externalTeamId: "team-eng",
        name: "Engineering",
        setBy: "admin",
        stateMap: { started: "s-progress", inReview: "s-review" },
        defaultProjectId: PROJECTS[0].id,
        acceptRuleSessions: false,
        ruleSessionsPerDay: 20,
        rules: [
          rule({ id: "rule-1", labels: ["l-bug", "l-ui"], priorities: ["1", "2"], assignees: ["unassigned"], stopped: state === "stopped" }),
          rule({ id: "rule-2", position: 1, projectId: null, states: ["s-todo"], enabled: state !== "connected" }),
          rule({ id: "rule-3", position: 2, projectId: PROJECTS[1].id, labels: ["l-gone"] }),
        ],
      },
    ],
  };
}

/** Settings → Org → Linear. state: none | connected | stopped | disconnected;
 *  role=member shows a member's read-only view. */
export function LinearFixture({ state, member }: { state: string; member: boolean }) {
  return (
    <SettingsFrame>
      <section className="space-y-8">
        <h1 className="text-lg font-medium">Linear</h1>
        <TrackerSettings provider="linear" orgId="org-1" admin={!member} available trackers={state === "none" ? [] : [tracker(state)]} projects={PROJECTS} />
      </section>
    </SettingsFrame>
  );
}

function jiraTracker(state: string): SettingsTracker {
  const base = tracker(state);
  const scope = base.scopes[0]!;
  return {
    ...base,
    provider: "jira",
    externalId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    connectedAs: "Outrunner Bot",
    webhookId: state === "no-webhook" ? null : "7",
    webhookProblem: state === "no-webhook",
    scopes: [
      {
        ...scope,
        externalTeamId: "10000",
        stateMap: { started: "3", inReview: "4" },
        rules: [rule({ id: "rule-1", labels: ["bug"], priorities: ["1"], issueTypes: ["10001"], assignees: ["unassigned"], stopped: false })],
      },
    ],
  };
}

/** Settings → Org → Jira. state: none | connected | disconnected. */
export function JiraFixture({ state, member }: { state: string; member: boolean }) {
  return (
    <SettingsFrame>
      <section className="space-y-8">
        <h1 className="text-lg font-medium">Jira</h1>
        <TrackerSettings provider="jira" orgId="org-1" admin={!member} available trackers={state === "none" ? [] : [jiraTracker(state)]} projects={PROJECTS} />
      </section>
    </SettingsFrame>
  );
}

/** Org → Integrations' Linear card, connected and with its connection lost. */
export function LinearCardFixture({ state }: { state: string }) {
  return (
    <SettingsFrame>
      <section className="@container space-y-6">
        <h1 className="text-lg font-medium">Integrations</h1>
        <div className="grid grid-cols-1 gap-4 @md:grid-cols-2">
          <IntegrationCard
            icon={<LinearIcon />}
            name="Linear"
            description="File issues to Triage by rules, and keep them in step."
            connected={state === "none" || state === "unset" ? null : "Acme"}
            problem={state === "disconnected" ? "Disconnected: rules have stopped. Reconnect it." : null}
            note={state === "unset" ? deploymentCard({ connected: false, admin: true, configureHref: "/settings/org/linear", installHref: null, setupDoc: "docs/linear-app.md" }).note : null}
            action={state === "unset" ? null : state === "none" ? { kind: "install", href: "/settings/org/linear" } : { kind: "configure", href: "/settings/org/linear" }}
          />
        </div>
      </section>
    </SettingsFrame>
  );
}

const ITEM: TriageItem = {
  id: "item-1",
  number: 12,
  projectId: null,
  title: "Checkout breaks on Safari",
  body: "Steps in the issue.",
  status: "triage",
  source: "linear",
  sourceUrl: "https://linear.app/acme/issue/ENG-1",
  sourceRef: "linear:issue-1",
  sourceAuthor: "Ana",
  duplicateOf: null,
  workspaceId: null,
  prompt: null,
  triagedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  can: { triage: true, contribute: true },
};

/** A work item in Triage. source=linear follows the tracker; source=app doesn't,
 *  to show the same page is editable when it's the org's own. */
export function TrackerItemFixture({ source }: { source: string }) {
  return (
    <WorkItemDetail
      id="item-1"
      projects={PROJECTS}
      moveTargets={PROJECTS}
      canUnsort
      items={[source === "app" ? { ...ITEM, source: "app", sourceRef: null, sourceUrl: null, sourceAuthor: null } : ITEM]}
      onChanged={() => undefined}
    />
  );
}
