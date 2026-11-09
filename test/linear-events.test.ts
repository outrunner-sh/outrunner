import assert from "node:assert/strict";
import { test } from "node:test";

import type { TrackerInstallation, TrackerScope } from "@/lib/db/trackers";
import type { TrackerFiling, TrackerNote } from "@/lib/db/work-items";
import { LinearUnavailableError } from "@/lib/trackers/linear";
import { handleLinearEvent, type LinearEventDeps } from "@/lib/trackers/linear-events";
import type { TrackerRule } from "@/lib/trackers/rules";
import type { TriageActor } from "@/lib/triage/access";
import type { WorkItem } from "@/lib/triage/work-items";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const TEAM = "team-1";
const INSTALL: TrackerInstallation = {
  id: "install",
  provider: "linear",
  externalId: "lin-org",
  siteUrl: null,
  name: "Acme",
  appUserId: "app-user",
  disconnected: false,
};

function scope(over: Partial<TrackerScope> = {}): TrackerScope {
  return {
    id: "scope-1",
    installationId: INSTALL.id,
    orgId: ORG,
    externalTeamId: TEAM,
    name: "Eng",
    setBy: "admin",
    stateMap: null,
    defaultProjectId: null,
    acceptRuleSessions: false,
    ruleSessionsPerDay: 20,
    ...over,
  };
}

function rule(over: Partial<TrackerRule> = {}): TrackerRule {
  return {
    id: "rule-1",
    scopeId: "scope-1",
    position: 0,
    projectId: null,
    setBy: "admin",
    enabled: true,
    labels: [],
    states: [],
    priorities: [],
    issueTypes: [],
    assignees: [],
    ...over,
  };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "item-1",
    number: 1,
    projectId: null,
    title: "Old title",
    body: "Old body",
    status: "triage",
    source: "linear",
    sourceUrl: null,
    sourceRef: "linear:issue-1",
    sourceAuthor: null,
    duplicateOf: null,
    workspaceId: null,
    prompt: null,
    triagedAt: null,
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
    ...over,
  };
}

function actor(userId: string, orgId = ORG): TriageActor {
  return { userId, orgId, orgLevel: "write", levels: new Map() };
}

/** Every dependency in memory, recording what the handler did. */
function harness(over: Partial<LinearEventDeps> = {}, setup: { scopes?: TrackerScope[]; rules?: TrackerRule[]; items?: Record<string, WorkItem> } = {}) {
  const scopes = setup.scopes ?? [scope()];
  const items = new Map(Object.entries(setup.items ?? {}));
  const seen = new Set<string>();
  const log = {
    filed: [] as { actor: string; filing: TrackerFiling }[],
    notes: [] as { orgId: string; itemId: string; note: TrackerNote }[],
    closed: [] as { orgId: string; close: unknown }[],
    reopened: [] as string[],
    followed: [] as { title?: string; body?: string }[],
    stopped: [] as string[],
    edited: [] as { sourceRef: string; body: string }[],
    deleted: [] as string[],
    asked: [] as string[],
    agent: [] as unknown[],
    stoppedDelegations: [] as string[],
    forgotten: [] as string[],
    redelegated: [] as string[],
    archived: [] as string[],
    deferred: [] as (() => Promise<unknown>)[],
  };
  const deps: LinearEventDeps = {
    installation: async (id) => (id === INSTALL.externalId ? INSTALL : null),
    forgetComment: async (id) => void log.forgotten.push(id),
    redelegated: async (_i, again) => void log.redelegated.push(again.actorId ?? `${again.issueId}, no person`),
    agentEvent: async (_i, payload, later) => {
      log.agent.push(payload);
      later(async () => undefined);
      return { handled: true };
    },
    workingTurns: async () => 1,
    stopDelegation: async (_i, issue) => {
      log.stoppedDelegations.push(issue);
    },
    appTokenWorks: async (id) => {
      log.asked.push(id);
      return false;
    },
    eventSeen: async (id) => seen.has(id),
    markEventSeen: async (id) => {
      const first = !seen.has(id);
      seen.add(id);
      return first;
    },
    scopeForTeam: async (_i, team) => scopes.find((s) => s.externalTeamId === team) ?? null,
    rulesForScope: async () => setup.rules ?? [rule()],
    orgIds: async () => [ORG, OTHER_ORG],
    linkedOwner: async () => null,
    triageActor: async (userId, orgId) => actor(userId, orgId),
    item: async (orgId, ref) => items.get(`${orgId}/${ref}`) ?? null,
    itemsInOrgs: async (orgIds, ref) =>
      orgIds.flatMap((orgId) => {
        const found = items.get(`${orgId}/${ref}`);
        return found ? [{ orgId, item: found }] : [];
      }),
    itemById: async (_o, id) => [...items.values()].find((i) => i.id === id) ?? null,
    file: async (a, filing) => {
      log.filed.push({ actor: a.userId, filing });
      return item();
    },
    followText: async (_o, _i, text) => void log.followed.push(text),
    close: async (orgId, _i, close) => void log.closed.push({ orgId, close }),
    reopen: async (_o, id) => {
      log.reopened.push(id);
      return item({ status: "triage" });
    },
    stopFollowing: async (_o, id) => void log.stopped.push(id),
    addNote: async (orgId, itemId, note) => void log.notes.push({ orgId, itemId, note }),
    editNote: async (sourceRef, body) => void log.edited.push({ sourceRef, body }),
    deleteNote: async (ref) => void log.deleted.push(ref),
    issueStanding: async () => ({ teamId: TEAM, open: true, stateType: "started" }),
    issueCreator: async () => null,
    duplicateOf: async () => null,
    session: async () => null,
    archiveOnClose: async () => true,
    wake: async () => true,
    suspend: async () => true,
    archiveServerSessions: async (_u, ids) => {
      log.archived.push(...ids);
      return ids.length;
    },
    defer: (work) => void log.deferred.push(work),
    ...over,
  };
  return { deps, log };
}

function issueEvent(over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    action: "create",
    type: "Issue",
    organizationId: INSTALL.externalId,
    actor: { id: "ana", name: "Ana", type: "user" },
    url: "https://linear.app/acme/issue/ENG-1",
    data: {
      id: "issue-1",
      teamId: TEAM,
      title: "New title",
      description: "New body",
      stateId: "state-todo",
      state: { type: "unstarted" },
      labelIds: ["label-bug"],
      priority: 2,
      assigneeId: null,
      creatorId: "ana",
      ...data,
    },
    ...over,
  };
}

function commentEvent(over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    action: "create",
    type: "Comment",
    organizationId: INSTALL.externalId,
    actor: { id: "ben", name: "Ben" },
    url: "https://linear.app/acme/issue/ENG-1#comment-1",
    data: { id: "comment-1", body: "A comment", issueId: "issue-1", userId: "ben", ...data },
    ...over,
  };
}

const send = (payload: unknown, deps: LinearEventDeps, deliveryId = "d1") => handleLinearEvent({ deliveryId, payload }, deps);
const held = (status: WorkItem["status"] = "triage", over: Partial<WorkItem> = {}) => ({ [`${ORG}/linear:issue-1`]: item({ status, ...over }) });

// --- Filing -----------------------------------------------------------------

test("a filed item remembers which install its issue is in", async () => {
  let got: string | undefined;
  const { deps } = harness({
    file: async (_a, _f, installationId) => {
      got = installationId;
      return item();
    },
  });
  await send(issueEvent(), deps);
  assert.equal(got, INSTALL.id);
});

test("a new issue matching a rule lands in triage, filed once by its source ref", async () => {
  const { deps, log } = harness({}, { rules: [rule({ labels: ["label-bug"], projectId: null })] });
  assert.deepEqual(await send(issueEvent(), deps), { handled: true });
  assert.equal(log.filed.length, 1);
  const { filing } = log.filed[0];
  assert.equal(filing.title, "New title");
  assert.equal(filing.body, "New body");
  assert.equal(filing.source, "linear");
  assert.equal(filing.sourceRef, "linear:issue-1");
  assert.equal(filing.sourceUrl, "https://linear.app/acme/issue/ENG-1");
  assert.equal(filing.sourceAuthor, "Ana");
});

test("a new issue no rule matches stays out", async () => {
  const { deps, log } = harness({}, { rules: [rule({ labels: ["label-other"] })] });
  await send(issueEvent(), deps);
  assert.equal(log.filed.length, 0);
});

test("a change to anything rules filter on re-checks them", async () => {
  for (const field of ["labelIds", "stateId", "priority", "assigneeId"]) {
    const { deps, log } = harness();
    await send(issueEvent({ action: "update", updatedFrom: { [field]: null } }), deps);
    assert.equal(log.filed.length, 1, field);
  }
});

test("a change to anything else doesn't", async () => {
  const { deps, log } = harness();
  await send(issueEvent({ action: "update", updatedFrom: { title: "Before" } }), deps);
  assert.equal(log.filed.length, 0);
});

test("priority, assignee and state are matched by the tracker's ids", async () => {
  const yes = harness({}, { rules: [rule({ priorities: ["2"], assignees: ["unassigned"], states: ["state-todo"] })] });
  await send(issueEvent(), yes.deps);
  assert.equal(yes.log.filed.length, 1);
  const no = harness({}, { rules: [rule({ priorities: ["1"] })] });
  await send(issueEvent(), no.deps);
  assert.equal(no.log.filed.length, 0);
});

test("an issue already closed isn't filed", async () => {
  const { deps, log } = harness();
  await send(issueEvent({}, { state: { type: "completed" } }), deps);
  assert.equal(log.filed.length, 0);
});

test("an issue from a team no org connected is ignored", async () => {
  const { deps, log } = harness();
  const result = await send(issueEvent({}, { teamId: "team-unknown" }), deps);
  assert.equal(result.handled, false);
  assert.equal(log.filed.length, 0);
});

test("once filed, the item stays when the issue stops matching, and matching again files nothing new", async () => {
  const { deps, log } = harness({}, { rules: [rule({ labels: ["label-other"] })], items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { labelIds: ["label-other"] } }), deps);
  assert.equal(log.filed.length, 0);
  assert.equal(log.closed.length, 0);
  const again = harness({}, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { labelIds: [] } }), again.deps);
  assert.equal(again.log.filed.length, 0);
});

test("an issue filed by a later change is credited to its creator, not that change's actor", async () => {
  const { deps, log } = harness({ issueCreator: async () => ({ id: "ana", name: "Ana" }) });
  await send(issueEvent({ action: "update", updatedFrom: { labelIds: [] }, actor: { id: "ben", name: "Ben" } }, { creatorId: undefined }), deps);
  assert.equal(log.filed[0].filing.sourceAuthor, "Ana");
});

test("that lookup failing doesn't stop the filing: the item just doesn't name them", async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const { deps, log } = harness({
      issueCreator: async () => {
        throw new Error("Linear is down");
      },
    });
    await send(issueEvent({ action: "update", updatedFrom: { labelIds: [] } }), deps);
    assert.equal(log.filed.length, 1);
    assert.equal(log.filed[0].filing.sourceAuthor, null);
  } finally {
    console.warn = warn;
  }
});

test("a creator found that way counts as the author when deciding who files", async () => {
  const { deps, log } = harness({
    issueCreator: async () => ({ id: "ana", name: "Ana" }),
    linkedOwner: async (_i, id) => (id === "ana" ? "ana-user" : null),
  });
  await send(issueEvent({ action: "update", updatedFrom: { labelIds: [] } }, { creatorId: undefined }), deps);
  assert.equal(log.filed[0].actor, "ana-user");
});

// --- Who files --------------------------------------------------------------

test("a linked author who may file is the actor", async () => {
  const { deps, log } = harness({ linkedOwner: async (_i, id) => (id === "ana" ? "ana-user" : null) });
  await send(issueEvent(), deps);
  assert.equal(log.filed[0].actor, "ana-user");
});

test("an unlinked author falls back to whoever set the rule", async () => {
  const { deps, log } = harness();
  await send(issueEvent(), deps);
  assert.equal(log.filed[0].actor, "admin");
});

test("a linked author who can't file to the rule's project falls back too", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const { deps, log } = harness(
    {
      linkedOwner: async () => "ana-user",
      triageActor: async (userId, orgId) =>
        userId === "admin" ? { ...actor(userId, orgId), levels: new Map([[projectId, "read" as const]]) } : actor(userId, orgId),
    },
    { rules: [rule({ projectId })] },
  );
  await send(issueEvent(), deps);
  assert.equal(log.filed[0].actor, "admin");
});

test("a rule whose setter left stops, even with a linked author", async () => {
  const { deps, log } = harness({
    linkedOwner: async () => "ana-user",
    triageActor: async (userId, orgId) => (userId === "admin" ? null : actor(userId, orgId)),
  });
  const result = await send(issueEvent(), deps);
  assert.equal(result.reason, "rule stopped");
  assert.equal(log.filed.length, 0);
});

test("a rule whose setter lost access to its project stops", async () => {
  const { deps, log } = harness({}, { rules: [rule({ projectId: "11111111-1111-4111-8111-111111111111" })] });
  const result = await send(issueEvent(), deps);
  assert.equal(result.reason, "rule stopped");
  assert.equal(log.filed.length, 0);
});

test("a rule with no setter stops", async () => {
  const { deps, log } = harness({}, { rules: [rule({ setBy: null })] });
  await send(issueEvent(), deps);
  assert.equal(log.filed.length, 0);
});

// --- The item follows the issue ---------------------------------------------

test("the item follows the tracker's title and description", async () => {
  const { deps, log } = harness({}, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { title: "Old title", description: "Old body" } }), deps);
  assert.deepEqual(log.followed, [{ title: "New title", body: "New body" }]);
});

test("an issue closed as done closes its open item as done", async () => {
  const { deps, log } = harness({}, { items: held("in_progress") });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "x" } }, { state: { type: "completed" } }), deps);
  assert.deepEqual(log.closed, [{ orgId: ORG, close: { status: "done" } }]);
});

test("an issue canceled declines its item", async () => {
  const { deps, log } = harness({}, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "x" } }, { state: { type: "canceled" } }), deps);
  assert.deepEqual(log.closed[0].close, { status: "declined" });
});

test("an issue marked a duplicate of one we hold open makes its item a duplicate", async () => {
  const items = { ...held(), [`${ORG}/linear:issue-2`]: item({ id: "item-2", sourceRef: "linear:issue-2" }) };
  const { deps, log } = harness({ duplicateOf: async () => "issue-2" }, { items });
  // Linear's own type for it, as a real workspace has it; older ones may say canceled.
  for (const type of ["duplicate", "canceled"]) {
    log.closed.length = 0;
    await send(issueEvent({ action: "update", updatedFrom: { stateId: "x" } }, { state: { type } }), deps, type);
    assert.deepEqual(log.closed[0].close, { status: "duplicate", duplicateOf: "item-2" }, type);
  }
});

test("an issue already a duplicate isn't filed by a rule", async () => {
  const { deps, log } = harness();
  await send(issueEvent({}, { state: { type: "duplicate" } }), deps);
  assert.equal(log.filed.length, 0);
});

test("a duplicate brought back to Todo reopens its item: Linear keeps its date in canceledAt", async () => {
  const { deps, log } = harness({}, { items: held("duplicate") });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "s-duplicate", canceledAt: "2026-11-08T10:37:04Z" } }), deps);
  assert.deepEqual(log.reopened, ["item-1"]);
});

test("Duplicate to Canceled is no new close", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held("todo", { workspaceId: "w" }) });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "s-duplicate", canceledAt: "2026-11-08T10:37:04Z" } }, { state: { type: "canceled" } }), deps);
  assert.equal(log.closed.length, 0);
  assert.equal(log.deferred.length, 0);
});

test("a duplicate of one we don't hold, or hold closed, is declined", async () => {
  const missing = harness({ duplicateOf: async () => "issue-2" }, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "x" } }, { state: { type: "canceled" } }), missing.deps);
  assert.deepEqual(missing.log.closed[0].close, { status: "declined" });
  const items = { ...held(), [`${ORG}/linear:issue-2`]: item({ id: "item-2", status: "done" }) };
  const closed = harness({ duplicateOf: async () => "issue-2" }, { items });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "x" } }, { state: { type: "canceled" } }), closed.deps);
  assert.deepEqual(closed.log.closed[0].close, { status: "declined" });
});

test("an item someone declined here stays declined when the issue closes there", async () => {
  const { deps, log } = harness({}, { items: held("declined") });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "x" } }, { state: { type: "completed" } }), deps);
  assert.equal(log.closed.length, 0);
});

test("a reopened issue puts its closed item back in triage, with a note", async () => {
  const { deps, log } = harness({}, { items: held("done") });
  await send(issueEvent({ action: "update", updatedFrom: { completedAt: "2026-11-01T00:00:00Z" } }), deps);
  assert.deepEqual(log.reopened, ["item-1"]);
  assert.match(log.notes[0].note.body, /reopened in Linear/);
  assert.equal(log.notes[0].note.authorId, null);
});

test("moving between open states doesn't undo a decision made here", async () => {
  const { deps, log } = harness({}, { items: held("declined") });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "x" } }), deps);
  assert.equal(log.reopened.length, 0);
});

test("an archived session stays archived when its issue reopens", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "archived" }) }, { items: held("done", { workspaceId: "w" }) });
  await send(issueEvent({ action: "update", updatedFrom: { canceledAt: "2026-11-01T00:00:00Z" } }), deps);
  assert.equal(log.deferred.length, 0);
  assert.equal(log.archived.length, 0);
});

// --- Closing and the session ------------------------------------------------

const closeEvent = () => issueEvent({ action: "update", updatedFrom: { stateId: "x" } }, { state: { type: "completed" } });

test("a close archives a live session after the answer, while the org says so", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held("in_progress", { workspaceId: "w" }) });
  await send(closeEvent(), deps);
  assert.equal(log.archived.length, 0, "not before the webhook has answered");
  assert.equal(log.deferred.length, 1);
  await log.deferred[0]();
  assert.deepEqual(log.archived, ["w"]);
});

test("a sleeping session is woken to be archived", async () => {
  const woken: string[] = [];
  const { deps, log } = harness(
    {
      session: async () => ({ id: "w", ownerId: "u", status: "suspended" }),
      wake: async (_u, id) => {
        woken.push(id);
        return true;
      },
    },
    { items: held("in_progress", { workspaceId: "w" }) },
  );
  await send(closeEvent(), deps);
  await log.deferred[0]();
  assert.deepEqual(woken, ["w"]);
  assert.deepEqual(log.archived, ["w"]);
});

test("with archive-on-close off the session stays, with a note", async () => {
  const { deps, log } = harness(
    { session: async () => ({ id: "w", ownerId: "u", status: "ready" }), archiveOnClose: async () => false },
    { items: held("in_progress", { workspaceId: "w" }) },
  );
  await send(closeEvent(), deps);
  assert.equal(log.deferred.length, 0);
  assert.match(log.notes[0].note.body, /session stays/i);
});

test("an item with no session, or one already archived, has nothing to archive", async () => {
  const none = harness({}, { items: held("in_progress") });
  await send(closeEvent(), none.deps);
  assert.equal(none.log.deferred.length, 0);
  const archived = harness({ session: async () => ({ id: "w", ownerId: "u", status: "archived" }) }, { items: held("in_progress", { workspaceId: "w" }) });
  await send(closeEvent(), archived.deps);
  assert.equal(archived.log.deferred.length, 0);
});

test("a session is archived when its item was already done: the PR merged, then Linear closed the issue", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held("done", { workspaceId: "w" }) });
  await send(closeEvent(), deps);
  assert.equal(log.closed.length, 0, "the item doesn't move");
  await log.deferred[0]();
  assert.deepEqual(log.archived, ["w"]);
});

test("a session is archived when its item was declined here first, and the decline stands", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held("declined", { workspaceId: "w" }) });
  await send(closeEvent(), deps);
  assert.equal(log.closed.length, 0);
  await log.deferred[0]();
  assert.deepEqual(log.archived, ["w"]);
});

test("Done → Canceled is no new close: a restored session stays, with no note, and the item doesn't move", async () => {
  const session = async () => ({ id: "w", ownerId: "u", status: "ready" });
  for (const archiveOnClose of [async () => true, async () => false]) {
    const { deps, log } = harness({ session, archiveOnClose }, { items: held("todo", { workspaceId: "w" }) });
    await send(issueEvent({ action: "update", updatedFrom: { stateId: "s-done", completedAt: "2026-11-01T00:00:00Z", canceledAt: null } }, { state: { type: "canceled" } }), deps);
    assert.equal(log.deferred.length, 0);
    assert.equal(log.notes.length, 0);
    assert.equal(log.closed.length, 0);
  }
});

test("Canceled → Done is no new close either", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held("declined", { workspaceId: "w" }) });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "s-canceled", canceledAt: "2026-11-01T00:00:00Z", completedAt: null } }, { state: { type: "completed" } }), deps);
  assert.equal(log.deferred.length, 0);
});

test("a closed issue moved to another of the org's teams is no new close", async () => {
  const { deps, log } = harness(
    { session: async () => ({ id: "w", ownerId: "u", status: "ready" }) },
    { scopes: [scope(), scope({ id: "scope-2", externalTeamId: "team-old" })], items: held("todo", { workspaceId: "w" }) },
  );
  await send(issueEvent({ action: "update", updatedFrom: { teamId: "team-old", stateId: "s-old-done" } }, { state: { type: "completed" } }), deps);
  assert.equal(log.deferred.length, 0);
  assert.equal(log.closed.length, 0);
});

test("an edit to a closed issue doesn't archive a session someone restored, or close an item reopened here", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held("todo", { workspaceId: "w" }) });
  await send(issueEvent({ action: "update", updatedFrom: { title: "Old title" } }, { state: { type: "completed" } }), deps);
  assert.equal(log.deferred.length, 0);
  assert.equal(log.closed.length, 0);
  assert.equal(log.followed.length, 1);
});

// --- Deleted ----------------------------------------------------------------

test("a deleted issue declines its item, with a note, and treats the session as a close", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held("todo", { workspaceId: "w" }) });
  await send(issueEvent({ action: "remove" }, { trashed: true }), deps);
  assert.deepEqual(log.closed[0].close, { status: "declined" });
  assert.match(log.notes[0].note.body, /deleted in Linear/);
  assert.equal(log.deferred.length, 1);
});

test("archiving sends remove too, without trashed: an open item stays, says why, and its session is left", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held("todo", { workspaceId: "w" }) });
  await send(issueEvent({ action: "remove" }), deps, "d7");
  assert.equal(log.closed.length, 0);
  assert.equal(log.deferred.length, 0);
  assert.equal(log.notes.length, 1);
  assert.equal(log.notes[0].note.body, "The issue was archived or deleted in Linear. This item stays open.");
  assert.equal(log.notes[0].note.sourceRef, "linear:d7:archived");
});

test("archiving a closed issue adds nothing: Linear does it by itself to long-closed ones", async () => {
  for (const status of ["done", "declined", "duplicate"] as const) {
    const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held(status, { workspaceId: "w" }) });
    await send(issueEvent({ action: "remove" }, { state: { type: "completed" } }), deps);
    assert.equal(log.notes.length, 0, status);
    assert.equal(log.closed.length, 0, status);
    assert.equal(log.deferred.length, 0, status);
  }
});

test("a session on a closed item goes with a deleted issue too; the item isn't noted twice over", async () => {
  const { deps, log } = harness({ session: async () => ({ id: "w", ownerId: "u", status: "ready" }) }, { items: held("declined", { workspaceId: "w" }) });
  await send(issueEvent({ action: "remove" }, { trashed: true }), deps);
  assert.equal(log.closed.length, 0);
  assert.equal(log.notes.length, 0);
  assert.equal(log.deferred.length, 1);
});

test("an edit to an issue already in the trash does nothing", async () => {
  const { deps, log } = harness({}, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { title: "x" } }, { trashed: true }), deps);
  assert.equal(log.closed.length, 0);
  assert.equal(log.followed.length, 0);
});

test("restoring it, which is its own action, counts as a reopen", async () => {
  const { deps, log } = harness({}, { items: held("declined") });
  await send(issueEvent({ action: "restore" }), deps);
  assert.deepEqual(log.reopened, ["item-1"]);
  assert.match(log.notes[0].note.body, /reopened in Linear/);
});

test("restoring a closed issue from an archive doesn't reopen its item", async () => {
  const { deps, log } = harness({}, { items: held("done") });
  await send(issueEvent({ action: "restore" }, { state: { type: "completed" } }), deps);
  assert.equal(log.reopened.length, 0);
});

test("restoring an issue whose item is open says so, as the archive's note would go stale", async () => {
  const { deps, log } = harness({}, { items: held("todo") });
  await send(issueEvent({ action: "restore" }), deps, "d8");
  assert.equal(log.reopened.length, 0);
  assert.equal(log.notes.length, 1);
  assert.equal(log.notes[0].note.body, "The issue is back in Linear.");
  assert.equal(log.notes[0].note.sourceRef, "linear:d8:restored");
});

test("a delete of an issue we don't hold files nothing", async () => {
  const { deps, log } = harness();
  await send(issueEvent({ action: "remove" }), deps);
  assert.equal(log.filed.length, 0);
});

// --- Moves ------------------------------------------------------------------

const moved = () => issueEvent({ action: "update", updatedFrom: { teamId: "team-old" } });

test("a move within the same scope, or between one org's teams, changes nothing", async () => {
  const same = harness({}, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { teamId: TEAM } }), same.deps);
  assert.equal(same.log.stopped.length, 0);
  const twoTeams = harness({}, { scopes: [scope(), scope({ id: "scope-2", externalTeamId: "team-old" })], items: held() });
  await send(moved(), twoTeams.deps);
  assert.equal(twoTeams.log.stopped.length, 0);
  assert.equal(twoTeams.log.notes.length, 0);
});

test("a move to another org's team leaves the item with a note, and the new org's rules decide", async () => {
  const { deps, log } = harness(
    {},
    {
      scopes: [scope({ orgId: OTHER_ORG }), scope({ id: "scope-2", externalTeamId: "team-old", orgId: ORG })],
      items: held(),
    },
  );
  await send(moved(), deps);
  assert.deepEqual(log.stopped, ["item-1"]);
  assert.equal(log.notes[0].orgId, ORG);
  assert.match(log.notes[0].note.body, /another Outrunner org/);
  assert.equal(log.filed.length, 1);
  assert.equal(log.closed.length, 0);
});

test("a move to a team not connected leaves the item with a note, and it stops following", async () => {
  const { deps, log } = harness(
    {},
    { scopes: [scope({ id: "scope-2", externalTeamId: "team-old" })], items: held() },
  );
  await send(moved(), deps);
  assert.deepEqual(log.stopped, ["item-1"]);
  assert.match(log.notes[0].note.body, /not connected to Outrunner/);
  assert.equal(log.filed.length, 0);
});

// --- Delegation -------------------------------------------------------------

test("an agent session's event goes to its handler, deduped like any other", async () => {
  const { deps, log } = harness();
  const event = { type: "AgentSessionEvent", action: "created", organizationId: INSTALL.externalId, agentSession: { id: "a" } };
  assert.deepEqual(await send(event, deps, "same"), { handled: true });
  assert.equal((await send(event, deps, "same")).reason, "already handled");
  assert.equal(log.agent.length, 1);
});

test("un-delegated while it works: the turn stops, with a note, and the item stays in progress", async () => {
  const { deps, log } = harness({}, { items: held("in_progress") });
  await send(issueEvent({ action: "update", updatedFrom: { delegateId: "app-user" } }, { delegateId: null }), deps);
  assert.deepEqual(log.stoppedDelegations, ["issue-1"]);
  assert.match(log.notes[0].note.body, /un-delegated/);
  assert.equal(log.closed.length, 0);
});

test("with nothing working, un-delegating adds no note", async () => {
  const { deps, log } = harness({ workingTurns: async () => 0 }, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { delegateId: "app-user" } }, { delegateId: null }), deps);
  assert.equal(log.notes.length, 0);
});

test("delegating, or moving a delegation between other people, isn't un-delegating", async () => {
  const delegated = harness({}, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { delegateId: null } }, { delegateId: "app-user" }), delegated.deps);
  assert.deepEqual(delegated.log.stoppedDelegations, []);
  const others = harness({}, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { delegateId: "someone" } }, { delegateId: "another" }), others.deps);
  assert.deepEqual(others.log.stoppedDelegations, []);
});

// --- Comments ---------------------------------------------------------------

test("a comment on an issue we hold is a note, with who wrote it and a way back", async () => {
  const { deps, log } = harness({}, { items: held() });
  await send(commentEvent(), deps);
  assert.equal(log.notes.length, 1);
  const { note, itemId, orgId } = log.notes[0];
  assert.equal(orgId, ORG);
  assert.equal(itemId, "item-1");
  assert.equal(note.body, "A comment");
  assert.equal(note.author, "Ben");
  assert.equal(note.source, "linear");
  assert.equal(note.sourceRef, "linear:comment:comment-1");
});

test("a comment on an issue we don't hold is ignored", async () => {
  const { deps, log } = harness();
  const result = await send(commentEvent(), deps);
  assert.equal(result.reason, "issue not held");
  assert.equal(log.notes.length, 0);
});

test("a linked commenter is the note's member; anyone else's has none, and is named", async () => {
  const linked = harness({ linkedOwner: async () => "ben-user" }, { items: held() });
  await send(commentEvent(), linked.deps);
  assert.equal(linked.log.notes[0].note.authorId, "ben-user");
  const unlinked = harness({}, { items: held() });
  await send(commentEvent(), unlinked.deps);
  assert.equal(unlinked.log.notes[0].note.authorId, null);
  assert.equal(unlinked.log.notes[0].note.author, "Ben");
});

test("a comment reopens a done item while the issue is open there", async () => {
  const { deps, log } = harness({}, { items: held("done") });
  await send(commentEvent(), deps);
  assert.deepEqual(log.reopened, ["item-1"]);
  assert.equal(log.notes.length, 1);
});

test("a comment on a closed issue doesn't reopen its item, but is still a note", async () => {
  const { deps, log } = harness({ issueStanding: async () => ({ teamId: TEAM, open: false, stateType: "completed" }) }, { items: held("done") });
  await send(commentEvent(), deps);
  assert.equal(log.reopened.length, 0);
  assert.equal(log.notes.length, 1);
});

test("a comment doesn't undo a decision made here: declined stays declined, with the note", async () => {
  const { deps, log } = harness({}, { items: held("declined") });
  await send(commentEvent(), deps);
  assert.equal(log.reopened.length, 0);
  assert.equal(log.notes.length, 1);
});

test("nor does it undo a duplicate whose original has closed", async () => {
  const items = {
    ...held("duplicate", { duplicateOf: "item-2" }),
    [`${ORG}/linear:issue-2`]: item({ id: "item-2", status: "done" }),
  };
  const { deps, log } = harness({}, { items });
  await send(commentEvent(), deps);
  assert.equal(log.reopened.length, 0);
  assert.equal(log.notes[0].itemId, "item-1");
});

test("a comment with no name reads as Linear's, not as the viewer's", async () => {
  const { deps, log } = harness({}, { items: held() });
  await send(commentEvent({ actor: null }), deps);
  assert.equal(log.notes[0].note.author, "Linear");
});

test("a comment on an item whose team was disconnected adds nothing", async () => {
  const { deps, log } = harness({}, { scopes: [], items: held("done") });
  const result = await send(commentEvent(), deps);
  assert.equal(result.reason, "team not connected");
  assert.equal(log.notes.length, 0);
  assert.equal(log.reopened.length, 0);
});

test("a comment on an issue now in another org's team adds nothing here", async () => {
  const { deps, log } = harness({}, { scopes: [scope({ orgId: OTHER_ORG })], items: held() });
  const result = await send(commentEvent(), deps);
  assert.equal(result.reason, "team not connected");
  assert.equal(log.notes.length, 0);
});

test("a comment on an issue Linear no longer has is answered, not retried", async () => {
  const seen: string[] = [];
  const { deps, log } = harness({ issueStanding: async () => null, markEventSeen: async (id) => (seen.push(id), true) }, { items: held() });
  const result = await send(commentEvent(), deps);
  assert.equal(result.reason, "issue not found");
  assert.equal(log.notes.length, 0);
  assert.deepEqual(seen, ["linear:d1"]);
});

test("edits and deletes still reach notes after the team is disconnected", async () => {
  const edit = harness({}, { scopes: [], items: held() });
  await send(commentEvent({ action: "update" }, { body: "Secret removed" }), edit.deps);
  assert.equal(edit.log.edited.length, 1);
  const remove = harness({}, { scopes: [], items: held() });
  await send(commentEvent({ action: "remove" }), remove.deps);
  assert.equal(remove.log.deleted.length, 1);
});

test("a duplicate's comment goes to what it duplicates, while that's open", async () => {
  const items = {
    ...held("duplicate", { duplicateOf: "item-2" }),
    [`${ORG}/linear:issue-2`]: item({ id: "item-2", status: "todo" }),
  };
  const { deps, log } = harness({}, { items });
  await send(commentEvent(), deps);
  assert.equal(log.notes[0].itemId, "item-2");
  assert.equal(log.reopened.length, 0);
});

test("an edited comment updates its note, and starts nothing", async () => {
  const { deps, log } = harness({}, { items: held("done") });
  await send(commentEvent({ action: "update" }, { body: "Edited, secret removed" }), deps);
  assert.deepEqual(log.edited, [{ sourceRef: "linear:comment:comment-1", body: "Edited, secret removed" }]);
  assert.equal(log.notes.length, 0);
  assert.equal(log.reopened.length, 0);
});

test("a deleted comment deletes its note", async () => {
  const { deps, log } = harness({}, { items: held() });
  await send(commentEvent({ action: "remove" }), deps);
  assert.deepEqual(log.deleted, ["linear:comment:comment-1"]);
});

test("an edit or delete reaches its note even when the item stopped following the issue", async () => {
  // No item holds the issue's ref any more: the note is found by its own.
  const edit = harness();
  await send(commentEvent({ action: "update" }, { body: "Edited" }), edit.deps);
  assert.equal(edit.log.edited.length, 1);
  const remove = harness();
  await send(commentEvent({ action: "remove" }), remove.deps);
  assert.equal(remove.log.deleted.length, 1);
});

test("an empty comment is no note", async () => {
  const { deps, log } = harness({}, { items: held() });
  await send(commentEvent({}, { body: "" }), deps);
  assert.equal(log.notes.length, 0);
});

// --- The guards -------------------------------------------------------------

test("our own events are dropped before dedupe, so they don't take its slot", async () => {
  let seenChecks = 0;
  const { deps, log } = harness(
    {
      eventSeen: async () => {
        seenChecks += 1;
        return false;
      },
    },
    { items: held("done") },
  );
  const own = await send(commentEvent({ actor: { id: "app-user", name: "Outrunner" } }, { userId: "app-user" }), deps);
  assert.equal(own.reason, "our own");
  assert.equal(seenChecks, 0);
  assert.equal(log.notes.length, 0);
  assert.equal(log.reopened.length, 0, "our comment must not reopen the item");
});

test("our own issue changes are dropped too", async () => {
  const { deps, log } = harness({}, { items: held() });
  const own = await send(issueEvent({ actor: { id: "app-user" }, action: "update", updatedFrom: { title: "x" } }), deps);
  assert.equal(own.reason, "our own");
  assert.equal(log.followed.length, 0);
});

test("a redelivered event acts once", async () => {
  const { deps, log } = harness();
  await send(issueEvent(), deps, "same");
  const second = await send(issueEvent(), deps, "same");
  assert.equal(second.reason, "already handled");
  assert.equal(log.filed.length, 1);
});

test("a failure leaves the event unseen, for the redelivery to act", async () => {
  let fail = true;
  const { deps, log } = harness({
    file: async (a, filing) => {
      if (fail) throw new Error("database down");
      log.filed.push({ actor: a.userId, filing });
      return item();
    },
  });
  await assert.rejects(send(issueEvent(), deps, "same"));
  fail = false;
  await send(issueEvent(), deps, "same");
  assert.equal(log.filed.length, 1);
});

test("a crash before the event is marked seen loses nothing: it's marked only once it's done", async () => {
  const order: string[] = [];
  const { deps } = harness({
    file: async () => {
      order.push("filed");
      return item();
    },
    markEventSeen: async () => (order.push("marked"), true),
  });
  await send(issueEvent(), deps);
  assert.deepEqual(order, ["filed", "marked"]);
});

test("a close that failed after the item closed is finished by the redelivery: its note and the archive", async () => {
  // The item as the database has it: closed by the first attempt.
  const stored = item({ status: "todo", workspaceId: "w" });
  let failSession = true;
  const { deps, log } = harness({
    item: async () => stored,
    close: async (_o, _i, close) => {
      stored.status = (close as { status: WorkItem["status"] }).status;
    },
    session: async () => {
      if (failSession) throw new Error("database down");
      return { id: "w", ownerId: "u", status: "ready" };
    },
  });
  await assert.rejects(send(issueEvent({ action: "remove" }, { trashed: true }), deps, "same"));
  assert.equal(stored.status, "declined");
  failSession = false;
  await send(issueEvent({ action: "remove" }, { trashed: true }), deps, "same");
  assert.match(log.notes[0].note.body, /deleted in Linear/);
  assert.equal(log.deferred.length, 1, "the archive still happens");
  await log.deferred[0]();
  assert.deepEqual(log.archived, ["w"]);
});

test("a note that failed before its change is added by the redelivery, then the change", async () => {
  let failNote = true;
  const { deps, log } = harness(
    {
      addNote: async (orgId, itemId, note) => {
        if (failNote) throw new Error("database down");
        log.notes.push({ orgId, itemId, note });
      },
    },
    { items: held("done") },
  );
  const reopened = issueEvent({ action: "update", updatedFrom: { completedAt: "x" } });
  await assert.rejects(send(reopened, deps, "same"));
  assert.equal(log.reopened.length, 0);
  failNote = false;
  await send(reopened, deps, "same");
  assert.equal(log.notes.length, 1);
  assert.deepEqual(log.reopened, ["item-1"]);
});

test("two deliveries at once are safe: the unique refs give one item and one note", async () => {
  const notes = new Set<string>();
  let items = 0;
  const filing = harness({
    file: async () => {
      // fileTrackerItem answers null on the unique (org, source_ref) violation.
      items += 1;
      return items === 1 ? item() : null;
    },
  });
  await Promise.all([send(issueEvent(), filing.deps, "same"), send(issueEvent(), filing.deps, "same")]);
  assert.equal(items, 2, "both tried, as neither had finished");

  const noting = harness(
    {
      // addTrackerNote ignores the unique (item, source_ref) violation.
      addNote: async (_o, _i, note) => void notes.add(note.sourceRef),
    },
    { items: held() },
  );
  await Promise.all([send(commentEvent(), noting.deps, "same"), send(commentEvent(), noting.deps, "same")]);
  assert.deepEqual([...notes], ["linear:comment:comment-1"]);
});

test("a system note's ref is the event's, so a redelivery adds it once", async () => {
  const { deps, log } = harness({}, { items: held("done") });
  await send(issueEvent({ action: "update", updatedFrom: { completedAt: "x" } }), deps, "d9");
  assert.equal(log.notes[0].note.sourceRef, "linear:d9:reopened");
});

test("an event from a workspace not installed, or disconnected, is ignored", async () => {
  const { deps, log } = harness();
  assert.equal((await send(issueEvent({ organizationId: "someone-else" }), deps)).reason, "not installed");
  assert.equal(log.filed.length, 0);
  const off = harness({ installation: async () => ({ ...INSTALL, disconnected: true }) });
  assert.equal((await send(issueEvent(), off.deps)).reason, "not installed");
  assert.equal(off.log.filed.length, 0);
});

test("a signed event with no organization is ignored, and warned about, with none of its contents", async () => {
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args);
  try {
    const { deps, log } = harness();
    assert.equal((await send(issueEvent({ organizationId: undefined }, { title: "Secret title" }), deps)).reason, "no organization");
    assert.equal(log.filed.length, 0);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.doesNotMatch(JSON.stringify(warned), /Secret title/);
});

test("an event of a kind we don't handle is ignored", async () => {
  const { deps, log } = harness();
  assert.equal((await send(issueEvent({ type: "Project" }), deps, "d2")).handled, false);
  assert.equal(log.filed.length, 0);
});

// --- Revocation -------------------------------------------------------------

// As Linear really sends them. oauthClientId is its id for the app, never client_id.
const revoked = (over: Record<string, unknown> = {}) => ({
  action: "revoked",
  type: "OAuthAuthorization",
  organizationId: INSTALL.externalId,
  oauthClientId: "fake-linear-app-id",
  userId: "app-user",
  activeTokensForUser: 0,
  ...over,
});

test("a person's revocation is no news: every link revokes one, and Linear isn't asked", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void warned.push(message);
  try {
    const { deps, log } = harness();
    assert.equal((await send(revoked({ userId: "ana" }), deps)).reason, "a person's");
    assert.deepEqual(log.asked, []);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warned, []);
});

test("the app's revocation with the token really gone is handled: the refused refresh disconnected it", async () => {
  const { deps, log } = harness();
  assert.deepEqual(await send(revoked(), deps), { handled: true });
  assert.deepEqual(log.asked, [INSTALL.id]);
});

test("oauthClientId isn't compared with our client_id: Linear's differs, and the signature already says it's ours", async () => {
  const { deps, log } = harness();
  await send(revoked({ oauthClientId: "anything" }), deps);
  assert.deepEqual(log.asked, [INSTALL.id]);
});

test("an app revocation with no userId is checked too", async () => {
  const { deps, log } = harness();
  await send(revoked({ userId: undefined }), deps);
  assert.deepEqual(log.asked, [INSTALL.id]);
});

test("the app's revocation while the token still works keeps the install, with a warning and none of its contents", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void warned.push(message);
  try {
    const { deps } = harness({ appTokenWorks: async () => true });
    assert.equal((await send(revoked(), deps)).reason, "token still works");
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /still works/);
  assert.doesNotMatch(warned[0], /lin-org|fake-linear-app-id/);
});

test("the app's revocation while Linear is down throws, so it's delivered again", async () => {
  const { deps } = harness({
    appTokenWorks: async () => {
      throw new LinearUnavailableError("down");
    },
  });
  await assert.rejects(send(revoked(), deps), LinearUnavailableError);
});

test("a new authorization is no news", async () => {
  const { deps, log } = harness();
  const result = await send(revoked({ action: "created", userId: "ana", activeTokensForUser: 1 }), deps);
  assert.equal(result.handled, false);
  assert.deepEqual(log.asked, []);
});

test("an agent event's later work is only asked for once it's marked seen", async () => {
  const event = { type: "AgentSessionEvent", action: "created", organizationId: INSTALL.externalId, agentSession: { id: "a" } };
  const later: unknown[] = [];
  const failing = harness({ markEventSeen: async () => assert.fail("database down"), defer: (work) => void later.push(work) });
  await assert.rejects(send(event, failing.deps));
  assert.equal(later.length, 0, "the retry starts it, not both");
  const works = harness({ defer: (work) => void later.push(work) });
  await send(event, works.deps);
  assert.equal(later.length, 1);
});

test("a comment edited or deleted is forgotten by a waiting question too", async () => {
  const comment = (action: string) => ({ type: "Comment", action, organizationId: INSTALL.externalId, data: { id: "c9", issueId: "issue-1", body: "edited", userId: "ana" } });
  const edited = harness();
  await send(comment("update"), edited.deps);
  assert.deepEqual(edited.log.forgotten, ["c9"]);
  const removed = harness();
  await send(comment("remove"), removed.deps);
  assert.deepEqual(removed.log.forgotten, ["c9"]);
});

const delegateChange = (updatedFrom: Record<string, unknown>, delegateId: string | null) =>
  issueEvent({ action: "update", updatedFrom }, { delegateId, identifier: "ENG-1" });

test("delegated (real shape: updatedFrom has delegateId null): only asked about once it's marked seen", async () => {
  const later: (() => Promise<unknown>)[] = [];
  const h = harness({ defer: (work) => void later.push(work) });
  await send(delegateChange({ delegateId: null, assigneeId: null }, INSTALL.appUserId), h.deps);
  assert.deepEqual(h.log.redelegated, [], "not yet");
  await later[0]?.();
  assert.deepEqual(h.log.redelegated, ["ana"]);
});

test("delegated to someone else, or an edit of a delegated issue, is no delegation", async () => {
  const later: unknown[] = [];
  const h = harness({ defer: (work) => void later.push(work) });
  await send(delegateChange({ delegateId: null }, "someone-else"), h.deps, "d1");
  await send(delegateChange({ title: "Old" }, INSTALL.appUserId), h.deps, "d2");
  assert.equal(later.length, 0);
});

test("un-delegated with no item yet still stops: a question waiting has none", async () => {
  const h = harness();
  await send(delegateChange({ delegateId: INSTALL.appUserId }, null), h.deps);
  assert.deepEqual(h.log.stoppedDelegations, ["issue-1"]);
  assert.equal(h.log.notes.length, 0, "there's nothing to note it on");
});

test("a bot's delegating isn't a person's: it takes the rule's path, with no one to run as", async () => {
  const later: (() => Promise<unknown>)[] = [];
  const h = harness({ defer: (work) => void later.push(work) });
  const event = { ...delegateChange({ delegateId: null }, INSTALL.appUserId), actor: { id: "integration-1", name: "Some Integration", type: "integration" } };
  await send(event, h.deps);
  await later[0]?.();
  assert.deepEqual(h.log.redelegated, ["issue-1, no person"]);
  const noType = harness({ defer: (work) => void later.push(work) });
  await send({ ...event, actor: { id: "x" } }, noType.deps, "d2");
  await later[1]?.();
  assert.deepEqual(noType.log.redelegated, ["issue-1, no person"]);
});

test("the time passed on is Linear's own, which a retry keeps", async () => {
  const seen: (number | null)[] = [];
  const later: (() => Promise<unknown>)[] = [];
  const h = harness({ redelegated: async (_i, again) => void seen.push(again.at), defer: (work) => void later.push(work) });
  await send({ ...delegateChange({ delegateId: null }, INSTALL.appUserId), createdAt: "2026-11-08T14:08:44.144Z", webhookTimestamp: 1 }, h.deps);
  await later[0]?.();
  assert.deepEqual(seen, [Date.parse("2026-11-08T14:08:44.144Z")]);
});

test("a person's delegating counts as theirs", async () => {
  const later: (() => Promise<unknown>)[] = [];
  const h = harness({ defer: (work) => void later.push(work) });
  await send({ ...delegateChange({ delegateId: null }, INSTALL.appUserId), actor: { id: "ana", name: "Ana", type: "user" } }, h.deps);
  await later[0]?.();
  assert.deepEqual(h.log.redelegated, ["ana"]);
});

test("un-delegated with no item: it stops, and the note's only where there's an item", async () => {
  const none = harness();
  await send(issueEvent({ action: "update", updatedFrom: { delegateId: "app-user" } }, { delegateId: null }), none.deps);
  assert.deepEqual(none.log.stoppedDelegations, ["issue-1"]);
  assert.equal(none.log.notes.length, 0);
});

test("the note goes first: a stop that fails is finished by the retry, with the note there", async () => {
  const order: string[] = [];
  const { deps } = harness({ addNote: async () => void order.push("note"), stopDelegation: async () => void order.push("stop") }, { items: held() });
  await send(issueEvent({ action: "update", updatedFrom: { delegateId: "app-user" } }, { delegateId: null }), deps);
  assert.deepEqual(order, ["note", "stop"]);
});

test("a comment goes to the org the team is connected to, not whichever holds an item", async () => {
  const ours = item({ id: "ours" });
  const stale = item({ id: "stale" });
  const h = harness({}, { scopes: [scope({ orgId: OTHER_ORG })], items: { [`${ORG}/linear:issue-1`]: stale, [`${OTHER_ORG}/linear:issue-1`]: ours } });
  await send(commentEvent(), h.deps);
  assert.deepEqual(h.log.notes.map((n) => [n.orgId, n.itemId]), [[OTHER_ORG, "ours"]]);
});

test("a session that couldn't be archived as its issue closed: the item says so", async () => {
  const h = harness({ session: async (id) => ({ id, ownerId: "o", status: "resuming" }) }, { items: held("triage", { workspaceId: "w" }) });
  await send(issueEvent({ action: "update", updatedFrom: { stateId: "old" } }, { state: { type: "completed" } }), h.deps);
  await h.log.deferred.at(-1)?.();
  assert.match(h.log.notes.at(-1)?.note.body ?? "", /couldn't be archived/);
});

test("a comment edited down to nothing with text: what it said still goes", async () => {
  const { deps, log } = harness({}, { items: held() });
  await send(commentEvent({ action: "update" }, { body: "" }), deps);
  assert.deepEqual(log.edited.map((e) => e.body), ["Edited in Linear to something with no text."]);
});

test("two copies of one agent event at once: only the first to mark it asks for later work", async () => {
  const event = { type: "AgentSessionEvent", action: "created", organizationId: INSTALL.externalId, agentSession: { id: "a" } };
  const later: unknown[] = [];
  let marks = 0;
  const { deps } = harness({ eventSeen: async () => false, markEventSeen: async () => ++marks === 1, defer: (work) => void later.push(work) });
  await Promise.all([send(event, deps), send(event, deps)]);
  assert.equal(later.length, 1);
});
