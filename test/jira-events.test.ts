import assert from "node:assert/strict";
import { test } from "node:test";

import type { TrackerInstallation, TrackerScope } from "@/lib/db/trackers";
import type { TrackerFiling, TrackerNote } from "@/lib/db/work-items";
import type { JiraIssueStanding } from "@/lib/trackers/jira";
import type { JiraTrigger } from "@/lib/trackers/jira-agent";
import { handleJiraEvent, type JiraEventDeps, siteHint } from "@/lib/trackers/jira-events";
import type { TrackerRule } from "@/lib/trackers/rules";
import type { TriageActor } from "@/lib/triage/access";
import type { WorkItem } from "@/lib/triage/work-items";

// Shapes from Atlassian's webhook page and REST reference: none has met a real site.

const ORG = "org-a";
const PROJECT = "10000";
const CLOUD = "cloud-1";
const APP = "app-account";
const REF = `jira:${CLOUD}/1`;
const INSTALL: TrackerInstallation = { id: "install", provider: "jira", externalId: CLOUD, siteUrl: "https://acme.atlassian.net", name: "Acme", appUserId: APP, disconnected: false };

function scope(over: Partial<TrackerScope> = {}): TrackerScope {
  return { id: "scope-1", installationId: "install", orgId: ORG, externalTeamId: PROJECT, name: "Eng", setBy: "admin", stateMap: null, defaultProjectId: null, acceptRuleSessions: false, ruleSessionsPerDay: 20, ...over };
}

function rule(over: Partial<TrackerRule> = {}): TrackerRule {
  return { id: "rule-1", scopeId: "scope-1", position: 0, projectId: null, setBy: "admin", enabled: true, labels: [], states: [], priorities: [], issueTypes: [], assignees: [], ...over };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "item-1", number: 1, projectId: null, title: "Old", body: "Old body", status: "triage", source: "jira", sourceUrl: null, sourceRef: REF, sourceAuthor: null,
    duplicateOf: null, workspaceId: null, prompt: null, triagedAt: null, createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z", ...over,
  };
}

const person = (accountId: string, displayName = accountId) => ({ accountId, displayName, accountType: "atlassian" });
const AUTOMATION = { accountId: "automation", displayName: "Automation for Jira", accountType: "app" };

function fields(over: Record<string, unknown> = {}) {
  return {
    summary: "Checkout breaks",
    description: "Steps",
    labels: ["bug"],
    project: { id: PROJECT },
    status: { id: "1", statusCategory: { key: "new" } },
    priority: { id: "2" },
    issuetype: { id: "10001" },
    assignee: null,
    creator: person("ana", "Ana"),
    ...over,
  };
}

function issue(over: Record<string, unknown> = {}, id = "1") {
  return { id, key: `ENG-${id}`, self: `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/2/issue/${id}`, fields: fields(over) };
}

function updated(items: Record<string, unknown>[], over: Record<string, unknown> = {}, user: unknown = person("ben", "Ben")) {
  return { webhookEvent: "jira:issue_updated", user, issue: issue(over), changelog: { items } };
}

function harness(over: Partial<JiraEventDeps> = {}, setup: { rules?: TrackerRule[]; items?: Record<string, WorkItem>; scopes?: TrackerScope[]; statusTypes?: Record<string, string>; standing?: Partial<JiraIssueStanding> | null } = {}) {
  const items = new Map(Object.entries(setup.items ?? {}));
  const scopes = setup.scopes ?? [scope()];
  const seen = new Set<string>();
  const log = {
    filed: [] as { actor: string; filing: TrackerFiling }[],
    notes: [] as { itemId: string; note: TrackerNote }[],
    closed: [] as unknown[],
    reopened: [] as string[],
    followed: [] as { title?: string; body?: string }[],
    stopped: [] as string[],
    edited: [] as string[],
    deleted: [] as string[],
    forgotten: [] as string[],
    triggers: [] as JiraTrigger[],
    stoppedDelegations: [] as string[],
    archived: 0,
    deferred: [] as (() => Promise<unknown>)[],
    hints: [] as unknown[],
  };
  const deps: JiraEventDeps = {
    installation: async (hint) => {
      log.hints.push(hint);
      return INSTALL;
    },
    eventSeen: async (id) => seen.has(id),
    markEventSeen: async (id) => {
      const first = !seen.has(id);
      seen.add(id);
      return first;
    },
    scopeForTeam: async (_i, projectId) => scopes.find((s) => s.externalTeamId === projectId) ?? null,
    rulesForScope: async () => setup.rules ?? [],
    orgIds: async () => [ORG],
    linkedOwner: async (_i, id) => (id === "ana" ? "ana-user" : null),
    triageActor: async (userId, orgId): Promise<TriageActor | null> => ({ userId, orgId, orgLevel: "write", levels: new Map() }),
    item: async (_o, ref) => items.get(ref) ?? null,
    itemsInOrgs: async (_o, ref) => {
      const found = items.get(ref);
      return found ? [{ orgId: ORG, item: found }] : [];
    },
    itemById: async (_o, id) => [...items.values()].find((i) => i.id === id) ?? null,
    file: async (actor, filing) => {
      log.filed.push({ actor: actor.userId, filing });
      return item();
    },
    followText: async (_o, _i, text) => void log.followed.push(text),
    close: async (_o, _i, close) => void log.closed.push(close),
    reopen: async (_o, id) => {
      log.reopened.push(id);
      return item();
    },
    stopFollowing: async (_o, id) => void log.stopped.push(id),
    addNote: async (_o, itemId, note) => void log.notes.push({ itemId, note }),
    editNote: async (ref) => void log.edited.push(ref),
    deleteNote: async (ref) => void log.deleted.push(ref),
    forgetComment: async (_i, id) => void log.forgotten.push(id),
    issueStanding: async () =>
      setup.standing === null ? null : { assigneeId: null, teamId: PROJECT, key: "ENG-1", title: "T", description: "", open: true, stateType: "unstarted", creatorId: "ana", creatorName: "Ana", duplicateOf: null, ...setup.standing },
    statusType: async (_i, id) => setup.statusTypes?.[id] ?? "unstarted",
    session: async (id) => ({ id, ownerId: "o", status: "ready" }),
    archiveOnClose: async () => true,
    wake: async () => true,
    suspend: async () => undefined,
    archiveServerSessions: async () => {
      log.archived += 1;
      return 1;
    },
    trigger: (_i, trigger) => void log.triggers.push(trigger),
    workingTurns: async () => 1,
    stopDelegation: async (_i, id) => {
      log.stoppedDelegations.push(id);
    },
    defer: (work) => void log.deferred.push(work),
    ...over,
  };
  let n = 0;
  return { deps, log, send: (payload: unknown, identifier: string | null = `e${(n += 1)}`, site = CLOUD) => handleJiraEvent({ identifier, payload, site }, deps) };
}

test("the site is read from what an event's self URLs say, as its payload has no site field", () => {
  assert.deepEqual(siteHint({ issue: { self: "https://api.atlassian.com/ex/jira/cloud-9/rest/api/2/issue/1" } }), { cloudId: "cloud-9", host: null });
  assert.deepEqual(siteHint({ issue: { self: "https://acme.atlassian.net/rest/api/2/issue/1" } }), { cloudId: null, host: "acme.atlassian.net" });
  assert.deepEqual(siteHint({ comment: { self: "https://acme.atlassian.net/rest/api/3/issue/1/comment/2" } }), { cloudId: null, host: "acme.atlassian.net" });
  // Webhook ids are per site: one in our table could be another site's event.
  assert.deepEqual(siteHint({ matchedWebhookIds: [4] } as Parameters<typeof siteHint>[0]), { cloudId: null, host: null });
});

test("a site we don't have, or one disconnected, is ignored", async () => {
  const none = harness({ installation: async () => null });
  assert.equal((await none.send({ webhookEvent: "jira:issue_created", issue: issue() })).reason, "not installed");
  const off = harness({ installation: async () => ({ ...INSTALL, disconnected: true }) });
  assert.equal((await off.send({ webhookEvent: "jira:issue_created", issue: issue() })).reason, "not installed");
});

test("an event whose signed token is another site's is ignored, before anything is done", async () => {
  const h = harness({ eventSeen: async () => assert.fail("not deduped"), markEventSeen: async () => assert.fail("not marked") }, { rules: [rule()] });
  const result = await h.send({ webhookEvent: "jira:issue_created", issue: issue() }, "e-other", "cloud-other");
  assert.deepEqual(result, { handled: false, reason: "wrong site" });
  assert.equal(h.log.triggers.length, 0);
});

test("our own account's events are dropped before dedupe, comments by who last wrote them", async () => {
  const h = harness({ eventSeen: async () => assert.fail("not deduped") }, { rules: [rule()] });
  assert.equal((await h.send({ webhookEvent: "jira:issue_updated", user: person(APP), issue: issue(), changelog: { items: [{ field: "labels" }] } })).reason, "our own");
  assert.equal((await h.send({ webhookEvent: "comment_created", issue: issue(), comment: { id: "9", body: "x", author: person(APP) } })).reason, "our own");
  assert.equal((await h.send({ webhookEvent: "comment_updated", issue: issue(), comment: { id: "9", body: "x", author: person("ana"), updateAuthor: person(APP) } })).reason, "our own");
  assert.deepEqual(h.log.filed, []);
});

test("a retry keeps its identifier: handled once, and an event that failed is finished by its retry", async () => {
  const h = harness({}, { rules: [rule()] });
  const created = { webhookEvent: "jira:issue_created", user: person("ben"), issue: issue() };
  assert.equal((await h.send(created, "same")).handled, true);
  assert.equal((await h.send(created, "same")).reason, "already handled");
  assert.equal(h.log.filed.length, 1);
  assert.equal((await h.send(created, null)).reason, "already handled", "it's known by the issue, not the delivery");
  assert.equal((await h.send({ webhookEvent: "jira:issue_updated", user: person("ben"), issue: issue() }, null)).reason, "no identifier");

  let fail = true;
  const flaky = harness(
    {
      file: async () => {
        if (fail) throw new Error("boom");
        return item();
      },
    },
    { rules: [rule()] },
  );
  await assert.rejects(flaky.send(created, "again"));
  fail = false;
  assert.equal((await flaky.send(created, "again")).handled, true);
});

test("doubled by two webhooks (a re-register, a stray): the same change counts once", async () => {
  const change = { webhookEvent: "jira:issue_updated", user: person("ben"), issue: issue(), changelog: { id: "501", items: [{ field: "assignee", to: APP }] } };
  const h = harness();
  await h.send(change, "from-the-old-webhook");
  assert.equal((await h.send(change, "from-the-new-webhook")).reason, "already handled");
  assert.equal(h.log.triggers.length, 1);
  await h.send({ ...change, changelog: { id: 502, items: [{ field: "labels" }] } }, "x");
  assert.equal(h.log.triggers.length, 1, "another change is its own");

  const said = { webhookEvent: "comment_created", issue: issue(), comment: { id: "9", body: `[~accountid:${APP}] go`, updated: "2026-11-08T00:00:00Z", author: person("ana") } };
  const twice = harness();
  await twice.send(said, "a");
  assert.equal((await twice.send(said, "b")).reason, "already handled");
  assert.equal(twice.log.triggers.length, 1);
  const edited = { ...said, webhookEvent: "comment_updated", comment: { ...said.comment, updated: "2026-11-08T01:00:00Z" } };
  assert.equal((await twice.send(edited, "c")).handled, true, "an edit is news");
  assert.equal((await twice.send({ ...edited, comment: { ...edited.comment, updated: "2026-11-08T02:00:00Z" } }, "d")).handled, true, "and so is another");
});

test("a session is only asked for once the event's marked seen: a failed mark means a retry, not a second turn", async () => {
  let failing = true;
  const h = harness({
    markEventSeen: async () => {
      if (failing) throw new Error("database down");
      return true;
    },
  });
  const change = updated([{ field: "assignee", to: APP }]);
  await assert.rejects(h.send(change, "retry"));
  assert.deepEqual(h.log.triggers, []);
  failing = false;
  await h.send(change, "retry");
  assert.equal(h.log.triggers.length, 1);
});

test("a new issue matching a rule is filed as its linked author, by its id-based ref", async () => {
  const h = harness({}, { rules: [rule({ labels: ["bug"], states: ["1"], priorities: ["2"], issueTypes: ["10001"], assignees: ["unassigned"] })] });
  await h.send({ webhookEvent: "jira:issue_created", user: person("ben"), issue: issue() });
  assert.equal(h.log.filed[0]?.actor, "ana-user");
  assert.deepEqual(h.log.filed[0]?.filing, { title: "Checkout breaks", body: "Steps", projectId: null, source: "jira", sourceUrl: "https://acme.atlassian.net/browse/ENG-1", sourceRef: REF, sourceAuthor: "Ana" });
});

test("rules: a mismatch files nothing, a closed issue never, and only a filtered field re-checks", async () => {
  const h = harness({}, { rules: [rule({ issueTypes: ["10002"] })] });
  assert.equal((await h.send({ webhookEvent: "jira:issue_created", issue: issue() })).reason, "no rule matches");
  const closed = harness({}, { rules: [rule()] });
  assert.equal((await closed.send({ webhookEvent: "jira:issue_created", issue: issue({ status: { id: "5", statusCategory: { key: "done" } } }) })).reason, "closed");
  const edit = harness({}, { rules: [rule()] });
  assert.equal((await edit.send(updated([{ field: "summary" }]))).reason, "nothing rules look at");
  for (const field of ["labels", "status", "priority", "issuetype", "assignee", "project"]) {
    const change = harness({}, { rules: [rule()] });
    assert.equal((await change.send(updated([{ field, fieldId: field }]))).handled, true, field);
  }
});

test("a rule's setter who has left stops it, and an unlinked author files as the setter", async () => {
  const stopped = harness({ triageActor: async () => null }, { rules: [rule()] });
  assert.equal((await stopped.send({ webhookEvent: "jira:issue_created", issue: issue() })).reason, "rule stopped");
  const unlinked = harness({ linkedOwner: async () => null }, { rules: [rule()] });
  await unlinked.send({ webhookEvent: "jira:issue_created", issue: issue() });
  assert.equal(unlinked.log.filed[0]?.actor, "admin");
});

test("an event without its creator asks Jira, and a bot's issue names no one", async () => {
  const h = harness({}, { rules: [rule()], standing: { creatorId: "ana", creatorName: "Ana" } });
  await h.send(updated([{ field: "labels" }], { creator: undefined }));
  assert.equal(h.log.filed[0]?.actor, "ana-user");
  assert.equal(h.log.filed[0]?.filing.sourceAuthor, "Ana");
  const bot = harness({}, { rules: [rule()], standing: { creatorId: null, creatorName: null } });
  await bot.send(updated([{ field: "labels" }], { creator: AUTOMATION }));
  assert.equal(bot.log.filed[0]?.actor, "admin");
  assert.equal(bot.log.filed[0]?.filing.sourceAuthor, null);
});

test("an item follows the summary and description, from a document too, and not what didn't change", async () => {
  const h = harness({}, { items: { [REF]: item() } });
  await h.send(updated([{ field: "summary" }, { field: "description" }], { description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "New body" }] }] } }));
  assert.deepEqual(h.log.followed, [{ title: "Checkout breaks", body: "New body" }]);
  const quiet = harness({}, { items: { [REF]: item() } });
  await quiet.send(updated([{ field: "labels" }]));
  assert.deepEqual(quiet.log.followed, []);
});

const toDone = (resolution?: string) => updated([{ field: "status", from: "1", to: "5" }], { status: { id: "5", statusCategory: { key: "done" } }, ...(resolution ? { resolution: { name: resolution } } : {}) });

test("closing: done by default, declined for a resolution that says so, a duplicate of an original we hold", async () => {
  const done = harness({}, { items: { [REF]: item() } });
  await done.send(toDone("Done"));
  assert.deepEqual(done.log.closed, [{ status: "done" }]);
  const none = harness({}, { items: { [REF]: item() } });
  await none.send(toDone());
  assert.deepEqual(none.log.closed, [{ status: "done" }]);
  for (const name of ["Won't Do", "Declined", "Cannot Reproduce"]) {
    const declined = harness({}, { items: { [REF]: item() } });
    await declined.send(toDone(name));
    assert.deepEqual(declined.log.closed, [{ status: "declined" }], name);
  }
  const original = item({ id: "item-2", sourceRef: `jira:${CLOUD}/8` });
  const duplicate = harness({}, { items: { [REF]: item(), [`jira:${CLOUD}/8`]: original }, standing: { duplicateOf: "8" } });
  await duplicate.send(toDone("Duplicate"));
  assert.deepEqual(duplicate.log.closed, [{ status: "duplicate", duplicateOf: "item-2" }]);
  const unheld = harness({}, { items: { [REF]: item() }, standing: { duplicateOf: "8" } });
  await unheld.send(toDone("Duplicate"));
  assert.deepEqual(unheld.log.closed, [{ status: "declined" }]);
});

test("Done to Closed is no new close, so a session someone restored stays", async () => {
  const h = harness({}, { items: { [REF]: item({ status: "done", workspaceId: "w" }) }, statusTypes: { "5": "completed" } });
  await h.send(updated([{ field: "status", from: "5", to: "6" }], { status: { id: "6", statusCategory: { key: "done" } } }));
  assert.deepEqual(h.log.closed, []);
  assert.deepEqual(h.log.deferred, []);
});

test("closing leaves a decision made here, and archives the session only if the org does", async () => {
  const declined = harness({}, { items: { [REF]: item({ status: "declined" }) } });
  await declined.send(toDone("Done"));
  assert.deepEqual(declined.log.closed, []);

  const archives = harness({}, { items: { [REF]: item({ workspaceId: "w" }) } });
  await archives.send(toDone("Done"));
  await archives.log.deferred[0]?.();
  assert.equal(archives.log.archived, 1);

  const keeps = harness({ archiveOnClose: async () => false }, { items: { [REF]: item({ workspaceId: "w" }) } });
  await keeps.send(toDone("Done"));
  assert.deepEqual(keeps.log.deferred, []);
  assert.match(keeps.log.notes[0]?.note.body ?? "", /session stays/);
});

test("reopened there: a closed item goes back, with a note, and an open one isn't touched", async () => {
  const change = updated([{ field: "status", from: "5", to: "1" }]);
  const h = harness({}, { items: { [REF]: item({ status: "done" }) }, statusTypes: { "5": "completed" } });
  await h.send(change);
  assert.deepEqual(h.log.reopened, ["item-1"]);
  assert.match(h.log.notes[0]?.note.body ?? "", /reopened in Jira/);
  const open = harness({}, { items: { [REF]: item() }, statusTypes: { "5": "completed" } });
  await open.send(change);
  assert.deepEqual(open.log.reopened, []);
});

test("a move takes a status there: not a close or a reopen", async () => {
  const other = scope({ id: "scope-2", externalTeamId: "20000" });
  const h = harness({}, { scopes: [scope(), other], items: { [REF]: item() } });
  await h.send(updated([{ field: "status", from: "1", to: "5" }, { field: "project", from: PROJECT, to: "20000" }], { project: { id: "20000" }, status: { id: "5", statusCategory: { key: "done" } } }));
  assert.deepEqual(h.log.closed, []);
  assert.deepEqual(h.log.stopped, [], "same org: nothing");
});

test("moved to another org's project, or one not connected: the item stays, says so, and stops following", async () => {
  const away = harness({}, { scopes: [scope(), scope({ id: "scope-2", externalTeamId: "20000", orgId: "org-b" })], items: { [REF]: item() } });
  await away.send(updated([{ field: "project", from: PROJECT, to: "20000" }], { project: { id: "20000" } }));
  assert.deepEqual(away.log.stopped, ["item-1"]);
  assert.match(away.log.notes[0]?.note.body ?? "", /another Outrunner org/);
  const gone = harness({}, { items: { [REF]: item() } });
  const result = await gone.send(updated([{ field: "project", from: PROJECT, to: "30000" }], { project: { id: "30000" } }));
  assert.deepEqual(gone.log.stopped, ["item-1"]);
  assert.match(gone.log.notes[0]?.note.body ?? "", /not connected/);
  assert.equal(result.reason, "project not connected");
});

test("deleted: declined with a note if open, and its session handled as for a close", async () => {
  const h = harness({}, { items: { [REF]: item({ workspaceId: "w" }) } });
  await h.send({ webhookEvent: "jira:issue_deleted", user: person("ben"), issue: issue() });
  assert.deepEqual(h.log.closed, [{ status: "declined" }]);
  assert.match(h.log.notes[0]?.note.body ?? "", /deleted in Jira/);
  assert.equal(h.log.deferred.length, 1);
  const unheld = harness();
  assert.equal((await unheld.send({ webhookEvent: "jira:issue_deleted", issue: issue() })).reason, "issue not held");
});

const comment = (event: string, body: unknown, author: unknown = person("ana", "Ana")) => ({ webhookEvent: event, issue: issue(), comment: { id: "9", body, author } });

test("a comment on an issue we hold is a note: a member's only if linked, and it reopens a done item", async () => {
  const h = harness({}, { items: { [REF]: item({ status: "done" }) } });
  await h.send(comment("comment_created", "Looks wrong"));
  const note = h.log.notes[0]?.note;
  assert.equal(note?.authorId, "ana-user");
  assert.equal(note?.author, "Ana");
  assert.equal(note?.sourceRef, `jira:comment:${CLOUD}/9`);
  assert.equal(note?.sourceUrl, "https://acme.atlassian.net/browse/ENG-1?focusedCommentId=9");
  assert.deepEqual(h.log.reopened, ["item-1"]);

  const stranger = harness({}, { items: { [REF]: item() } });
  await stranger.send(comment("comment_created", "Hm", person("zed", "Zed")));
  assert.equal(stranger.log.notes[0]?.note.authorId, null);
  assert.equal(stranger.log.notes[0]?.note.author, "Zed");
});

test("a comment doesn't undo a decision here, nor reopen while the issue's closed, and a duplicate's goes to its original", async () => {
  const declined = harness({}, { items: { [REF]: item({ status: "declined" }) } });
  await declined.send(comment("comment_created", "x"));
  assert.deepEqual(declined.log.reopened, []);
  assert.equal(declined.log.notes.length, 1);
  const closed = harness({}, { items: { [REF]: item({ status: "done" }) }, standing: { open: false } });
  await closed.send(comment("comment_created", "x"));
  assert.deepEqual(closed.log.reopened, []);
  const original = item({ id: "item-2", sourceRef: "other" });
  const duplicate = harness({}, { items: { [REF]: item({ status: "duplicate", duplicateOf: "item-2" }), other: original } });
  await duplicate.send(comment("comment_created", "x"));
  assert.equal(duplicate.log.notes[0]?.itemId, "item-2");
});

test("a comment on an issue whose project left the org isn't noted", async () => {
  const h = harness({}, { scopes: [scope({ orgId: "org-b" })], items: { [REF]: item() } });
  assert.equal((await h.send(comment("comment_created", "x"))).reason, "project not connected");
  assert.deepEqual(h.log.notes, []);
});

test("an edit or delete reaches its note, and never starts anything", async () => {
  const h = harness();
  await h.send(comment("comment_updated", `[~accountid:${APP}] edited`));
  await h.send(comment("comment_deleted", `[~accountid:${APP}] gone`));
  assert.deepEqual(h.log.edited, [`jira:comment:${CLOUD}/9`]);
  assert.deepEqual(h.log.deleted, [`jira:comment:${CLOUD}/9`]);
  assert.deepEqual(h.log.forgotten, ["9", "9"], "a waiting question's copy goes too");
  assert.deepEqual(h.log.triggers, []);
});

test("assigned to our account by a person: a session is asked for, as them", async () => {
  const h = harness();
  const result = await h.send(updated([{ field: "assignee", fieldId: "assignee", from: null, to: APP }]));
  assert.equal(result.handled, true);
  assert.deepEqual(h.log.triggers, [{ kind: "assigned", issueId: "1", actor: { id: "ben", name: "Ben", kind: "person" }, text: null }]);
});

test("assigned by Automation for Jira: the same, marked as no person", async () => {
  const h = harness();
  await h.send(updated([{ field: "assignee", to: APP }], {}, AUTOMATION));
  assert.equal(h.log.triggers[0]?.actor.kind, "rule");
  // Only an app is a rule. A portal customer isn't a person, or a rule to run as a creator.
  const portal = harness();
  await portal.send(updated([{ field: "assignee", to: APP }], {}, { accountId: "c", accountType: "customer" }));
  assert.equal(portal.log.triggers[0]?.actor.kind, "other");
  const unsaid = harness();
  await unsaid.send(updated([{ field: "assignee", to: APP }], {}, { accountId: "c" }));
  assert.equal(unsaid.log.triggers[0]?.actor.kind, "other");
});

test("created assigned to us, or mentioning us in its description", async () => {
  const assigned = harness();
  await assigned.send({ webhookEvent: "jira:issue_created", user: person("ben"), issue: issue({ assignee: { accountId: APP } }) });
  assert.equal(assigned.log.triggers[0]?.kind, "assigned");
  const mentioned = harness();
  await mentioned.send({ webhookEvent: "jira:issue_created", user: person("ben"), issue: issue({ description: `[~accountid:${APP}] do this` }) });
  assert.equal(mentioned.log.triggers[0]?.kind, "mentioned");
});

test("a description only triggers when the mention is new", async () => {
  const first = harness();
  await first.send(updated([{ field: "description", fromString: "x", toString: `[~accountid:${APP}] x` }]));
  assert.equal(first.log.triggers[0]?.kind, "mentioned");
  const again = harness();
  await again.send(updated([{ field: "description", fromString: `[~accountid:${APP}] x`, toString: `[~accountid:${APP}] y` }]));
  assert.deepEqual(again.log.triggers, []);
});

test("another's assignee, or an edit of an assigned issue, asks for nothing", async () => {
  const h = harness();
  await h.send(updated([{ field: "assignee", to: "ben" }], { assignee: { accountId: "ben" } }));
  await h.send(updated([{ field: "labels" }], { assignee: { accountId: APP } }));
  assert.deepEqual(h.log.triggers, []);
});

test("an unconnected project still hears why: a trigger goes on, for a reply", async () => {
  const h = harness({}, { scopes: [] });
  const result = await h.send(updated([{ field: "assignee", to: APP }]));
  assert.equal(result.handled, true);
  assert.equal(h.log.triggers.length, 1);
});

test("assigned away while it works: the turn stops, with a note, and reassigning to us isn't that", async () => {
  const h = harness({}, { items: { [REF]: item({ status: "in_progress" }) } });
  await h.send(updated([{ field: "assignee", from: APP, to: "ben" }]));
  assert.deepEqual(h.log.stoppedDelegations, ["1"]);
  assert.match(h.log.notes[0]?.note.body ?? "", /unassigned in Jira/);
  assert.deepEqual(h.log.closed, [], "it stays in progress");
  const idle = harness({ workingTurns: async () => 0 }, { items: { [REF]: item() } });
  await idle.send(updated([{ field: "assignee", from: APP, to: "ben" }]));
  assert.deepEqual(idle.log.notes, [], "nothing was running");
  const other = harness({}, { items: { [REF]: item() } });
  await other.send(updated([{ field: "assignee", from: "ana", to: "ben" }]));
  assert.deepEqual(other.log.stoppedDelegations, []);
});

test("a mention in a comment asks for a session with its words, and is a note too", async () => {
  const h = harness({}, { items: { [REF]: item() } });
  await h.send(comment("comment_created", `[~accountid:${APP}] fix [repo=acme/web]`));
  assert.equal(h.log.notes.length, 1);
  assert.deepEqual(h.log.triggers, [{ kind: "mentioned", issueId: "1", actor: { id: "ana", name: "Ana", kind: "person" }, text: "@someone fix [repo=acme/web]", commentId: "9" }]);
  const unheld = harness();
  await unheld.send(comment("comment_created", { type: "doc", content: [{ type: "mention", attrs: { id: APP, text: "@Outrunner" } }] }));
  assert.equal(unheld.log.triggers[0]?.kind, "mentioned");
});

test("a comment naming a repository may answer the question, and any other is only a note", async () => {
  const h = harness();
  await h.send(comment("comment_created", "repo=acme/web"));
  assert.equal(h.log.triggers[0]?.kind, "reply");
  const plain = harness({}, { items: { [REF]: item() } });
  await plain.send(comment("comment_created", "the repo is broken"));
  assert.deepEqual(plain.log.triggers, []);
});

test("assigned away with no item: it stops, and the note's only where there's an item, first", async () => {
  const away = updated([{ fieldId: "assignee", from: APP, to: "ben" }]);
  const none = harness();
  await none.send(away);
  assert.deepEqual(none.log.stoppedDelegations, ["1"]);
  assert.equal(none.log.notes.length, 0);

  const order: string[] = [];
  const held = harness({ addNote: async () => void order.push("note"), stopDelegation: async () => void order.push("stop") }, { items: { [REF]: item() } });
  await held.send(away);
  assert.deepEqual(order, ["note", "stop"]);
});

test("a deleted or commented issue goes to the org its project is connected to", async () => {
  const twoOrgs = (scopes: TrackerScope[]) =>
    harness({ itemsInOrgs: async () => [{ orgId: "stale", item: item({ id: "stale" }) }, { orgId: ORG, item: item({ id: "ours" }) }] }, { scopes });
  const deleted = twoOrgs([scope()]);
  await deleted.send({ webhookEvent: "jira:issue_deleted", user: person("ben"), issue: issue() });
  assert.deepEqual(deleted.log.notes.map((n) => n.itemId), ["ours"]);
  const noted = twoOrgs([scope()]);
  await noted.send(comment("comment_created", "Looks wrong"));
  assert.deepEqual(noted.log.notes.map((n) => n.itemId), ["ours"]);

  const nowhere = twoOrgs([]);
  assert.equal((await nowhere.send({ webhookEvent: "jira:issue_deleted", user: person("ben"), issue: issue() })).reason, "project not connected");
  const unsaid = twoOrgs([scope()]);
  assert.equal((await unsaid.send({ webhookEvent: "jira:issue_deleted", user: person("ben"), issue: { id: "1" } })).reason, "project not connected");
  const single = harness({}, { items: { [REF]: item() } });
  assert.equal((await single.send({ webhookEvent: "jira:issue_deleted", user: person("ben"), issue: { id: "1" } })).handled, true, "only one it could be");
});

test("a session that couldn't be archived as its issue closed: the item says so", async () => {
  const h = harness({ session: async () => ({ id: "w", ownerId: "u", status: "resuming" }) }, { items: { [REF]: item({ workspaceId: "w" }) } });
  await h.send({ webhookEvent: "jira:issue_deleted", user: person("ben"), issue: issue() });
  await h.log.deferred.at(-1)?.();
  assert.match(h.log.notes.at(-1)?.note.body ?? "", /couldn't be archived/);
});

test("a comment edited down to nothing with text: what it said still goes", async () => {
  const bodies: string[] = [];
  const h = harness({ editNote: async (_ref, body) => void bodies.push(body) }, { items: { [REF]: item() } });
  await h.send(comment("comment_updated", { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "mediaSingle" }] }] }));
  assert.deepEqual(bodies, ["Edited in Jira to something with no text."]);
});

test("Won't Do, in the shapes real Jira sends", async () => {
  const wontDo = { resolution: { id: "10001", name: "Won't Do" } };
  const resolutionChange = (from: string | null, fromString: string | null) => ({ field: "resolution", fieldtype: "jira", fieldId: "resolution", from, fromString, to: "10001", toString: "Won't Do" });
  const open = { status: { id: "10003", statusCategory: { key: "new" } } };
  const closed = { status: { id: "10005", statusCategory: { key: "done" } } };

  // Set by an edit, as a workflow with no screen for it has to, on an issue still open: nothing's closed.
  const edited = harness({}, { items: { [REF]: item() } });
  await edited.send(updated([resolutionChange(null, null)], { ...wontDo, ...open }));
  assert.deepEqual(edited.log.closed, []);

  // Then moved to Done: the status event alone says it, and the resolution it carries decides.
  const closes = harness({}, { items: { [REF]: item() } });
  await closes.send(updated([{ field: "status", fieldtype: "jira", fieldId: "status", from: "10003", fromString: "To Do", to: "10005", toString: "Done" }], { ...wontDo, ...closed }));
  assert.deepEqual(closes.log.closed, [{ status: "declined" }]);

  // Together, as a transition screen sends them.
  const together = harness({}, { items: { [REF]: item() } });
  await together.send(updated([{ field: "status", fieldtype: "jira", fieldId: "status", from: "10003", fromString: "To Do", to: "10005", toString: "Done" }, resolutionChange(null, null)], { ...wontDo, ...closed }));
  assert.deepEqual(together.log.closed, [{ status: "declined" }]);

  // Edited once it's closed: what was decided on closing stands.
  const later = harness({}, { items: { [REF]: item({ status: "done" }) } });
  await later.send(updated([resolutionChange("10000", "Done")], { ...wontDo, ...closed }));
  assert.deepEqual(later.log.closed, []);
  assert.deepEqual(later.log.reopened, []);
});

test("two copies of one delivery at once, as a webhook's replacement overlaps: only the first to mark it acts", async () => {
  const seen = new Set<string>();
  const h = harness({
    eventSeen: async () => false,
    markEventSeen: async (id) => {
      const first = !seen.has(id);
      seen.add(id);
      return first;
    },
  });
  // The same change, with each webhook's own identifier.
  const made = updated([{ field: "assignee", to: APP }]);
  const change = { ...made, changelog: { ...made.changelog, id: "10001" } };
  await Promise.all([h.send(change, "a"), h.send(change, "b")]);
  assert.equal(h.log.triggers.length, 1);
});

test("a redelivery of a close finds the item already a duplicate, and still finishes it", async () => {
  const original = item({ id: "item-2" });
  const h = harness({}, { items: { [REF]: item({ status: "duplicate", duplicateOf: "item-2" }), [`jira:${CLOUD}/8`]: original }, standing: { duplicateOf: "8" } });
  await h.send(toDone("Duplicate"));
  assert.deepEqual(h.log.closed, [{ status: "duplicate", duplicateOf: "item-2" }]);
  // Decided on here, with nothing to finish: it stays as it was left.
  const decided = harness({}, { items: { [REF]: item({ status: "duplicate", duplicateOf: "item-9" }) } });
  await decided.send(toDone("Done"));
  assert.deepEqual(decided.log.closed, []);
  const declined = harness({}, { items: { [REF]: item({ status: "declined" }), [`jira:${CLOUD}/8`]: original }, standing: { duplicateOf: "8" } });
  await declined.send(toDone("Duplicate"));
  assert.deepEqual(declined.log.closed, []);
});
