import { OUTRUNNER_MODELS } from "@/lib/runtime/session-models";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JiraRow } from "@/lib/db/jira-sessions";
import type { TrackerInstallation, TrackerScope } from "@/lib/db/trackers";
import type { TrackerFiling, TrackerNote } from "@/lib/db/work-items";
import type { ServerSessionResult, ServerSessionStart } from "@/lib/session/server-session";
import type { JiraIssueStanding } from "@/lib/trackers/jira";
import { handleJiraTrigger, resumeJiraAfterLink, JIRA_REPLIES, type JiraAgentDeps, jiraCapReply, jiraFirstPrompt, type JiraTrigger } from "@/lib/trackers/jira-agent";
import { issueBranch } from "@/lib/trackers/issue-key";
import type { TriageActor } from "@/lib/triage/access";
import type { WorkItem } from "@/lib/triage/work-items";

const ORG = "org-a";
const PROJECT = "10000";
const ISSUE = "1";
const WEB = { id: "11111111-1111-4111-8111-111111111111", fullName: "acme/web" };
const API = { id: "22222222-2222-4222-8222-222222222222", fullName: "acme/api" };
const INSTALL: TrackerInstallation = { id: "install", provider: "jira", externalId: "cloud-1", siteUrl: "https://acme.atlassian.net", name: "Acme", appUserId: "app", disconnected: false };
const STANDING: JiraIssueStanding = { teamId: PROJECT, key: "ENG-1", title: "Fix it", description: "Steps", open: true, stateType: "unstarted", creatorId: "ana", creatorName: "Ana", duplicateOf: null, assigneeId: "app" };

function scope(over: Partial<TrackerScope> = {}): TrackerScope {
  return { id: "scope-1", installationId: "install", orgId: ORG, externalTeamId: PROJECT, name: "Eng", setBy: "admin", stateMap: { started: "3", inReview: "4" }, defaultProjectId: WEB.id, acceptRuleSessions: false, ruleSessionsPerDay: 20, ...over };
}

function actor(userId: string, projects = [WEB.id, API.id]): TriageActor {
  return { userId, orgId: ORG, orgLevel: "write", levels: new Map(projects.map((id) => [id, "read" as const])) };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "item-1", number: 1, projectId: null, title: "T", body: "", status: "triage", source: "jira", sourceUrl: null, sourceRef: `jira:cloud-1/${ISSUE}`, sourceAuthor: null,
    duplicateOf: null, workspaceId: null, prompt: null, triagedAt: null, createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z", ...over,
  };
}

const row = (over: Partial<JiraRow> = {}): JiraRow => ({ installationId: "install", issueId: ISSUE, orgId: ORG, itemId: null, workspaceId: null, ownerId: "ana-user", stage: "working", prompt: null, ruleStarted: false, ...over });
const assigned: JiraTrigger = { kind: "assigned", issueId: ISSUE, actor: { id: "ana", name: "Ana", kind: "person" }, text: null };
const mention = (text: string): JiraTrigger => ({ kind: "mentioned", issueId: ISSUE, actor: { id: "ana", name: "Ana", kind: "person" }, text });
const rule: JiraTrigger = { kind: "assigned", issueId: ISSUE, actor: { id: "automation", name: "Automation for Jira", kind: "rule" }, text: null };

type Setup = { scope?: TrackerScope | null; item?: WorkItem | null; row?: JiraRow | null; standing?: JiraIssueStanding | null; session?: { id: string; ownerId: string; projectId: string | null; status: string } | null };

function harness(over: Partial<JiraAgentDeps> = {}, setup: Setup = {}) {
  const log = {
    comments: [] as string[],
    links: [] as { url: string; title: string }[],
    transitions: [] as string[],
    started: [] as ServerSessionStart[],
    sent: [] as string[],
    filed: [] as TrackerFiling[],
    linked: [] as { workspaceId: string; projectId: string }[],
    notes: [] as TrackerNote[],
    awaited: 0,
    watches: 0,
    slots: 0,
    interrupted: [] as string[],
    saved: [] as JiraRow[],
    stopped: 0,
    released: 0,
    claims: 0,
  };
  let current: JiraRow | null = setup.row ?? null;
  const deps: JiraAgentDeps = {
    comment: async (_i, _issue, body) => void log.comments.push(body),
    remoteLink: async (_i, _issue, url, title) => void log.links.push({ url, title }),
    transition: async (_i, _issue, status) => {
      log.transitions.push(status);
      return true;
    },
    standing: async () => (setup.standing === undefined ? STANDING : setup.standing),
    scopeForTeam: async () => (setup.scope === undefined ? scope() : setup.scope),
    claimRuleSession: async () => {
      log.slots += 1;
      return true;
    },
    linkedOwner: async (_i, id) => (id === "ana" ? "ana-user" : id === "ben" ? "ben-user" : null),
    triageActor: async (userId) => actor(userId),
    projects: async () => [WEB, API],
    level: async () => "read",
    item: async () => setup.item ?? null,
    file: async (_a, filing) => {
      log.filed.push(filing);
      return item();
    },
    linkItem: async (_o, _i, session) => void log.linked.push(session),
    addNote: async (_o, _i, note) => void log.notes.push(note),
    row: async () => current,
    // As saveJiraRow does.
    saveRow: async (saved, seen) => {
      if (seen ? (current?.stopMark ?? null) !== (seen.stopMark ?? null) : current) return false;
      log.saved.push(saved);
      current = { ...saved, stopMark: current?.stopMark ?? null };
      return true;
    },
    setRowWorkspace: async (_i, _issue, workspaceId) => {
      if (current) current = { ...current, workspaceId };
    },
    stopRow: async () => {
      log.stopped += 1;
      current = { ...(current ?? row({ workspaceId: null })), stage: "stopped", stopMark: `stop-${log.stopped}` };
    },
    claim: async () => {
      log.claims += 1;
      return true;
    },
    release: async () => {
      log.released += 1;
    },
    session: async () => setup.session ?? null,
    start: async (start): Promise<ServerSessionResult> => {
      log.started.push(start);
      await start.onCreated?.("w-new");
      return { workspaceId: "w-new", status: "ready" } as ServerSessionResult;
    },
    send: async (_o, _w, text) => {
      log.sent.push(text);
      return true;
    },
    stop: async (_o, workspaceId) => {
      log.interrupted.push(workspaceId);
      return true;
    },
    branchFor: async (_p, key, title) => issueBranch("jira", key, title),
    sendBaseline: async () => 1000,
    openWatch: async () => {
      log.watches += 1;
    },
    watchReply: async () => {
      log.awaited += 1;
    },
    now: () => 5000,
    linkUrl: () => "https://app.test/api/integrations/jira/link",
    sessionUrl: (id) => `https://app.test/workspaces/${id}`,
    ...over,
  };
  return { deps, log, current: () => current, run: (trigger: JiraTrigger) => handleJiraTrigger(INSTALL, trigger, deps) };
}

test("assigned by someone linked: a session as them on the default repo, an item, a link and the started status", async () => {
  const h = harness();
  await h.run(assigned);
  assert.equal(h.log.started[0]?.userId, "ana-user");
  assert.equal(h.log.started[0]?.projectId, WEB.id);
  assert.equal(h.log.started[0]?.source, "jira");
  assert.equal(h.log.filed[0]?.sourceRef, "jira:cloud-1/1");
  assert.equal(h.log.filed[0]?.sourceAuthor, "Ana");
  assert.deepEqual(h.log.linked, [{ workspaceId: "w-new", projectId: WEB.id }]);
  assert.match(h.log.comments[0] ?? "", /Session started: \[open it in Outrunner\]\(https:\/\/app\.test\/workspaces\/w-new\)/);
  assert.deepEqual(h.log.links, [{ url: "https://app.test/workspaces/w-new", title: "Outrunner session" }]);
  assert.deepEqual(h.log.transitions, ["3"]);
  assert.equal(h.log.awaited, 1);
  assert.equal(h.log.released, 1);
});

test("the started status only moves an issue that hasn't started, and a workflow may offer no way", async () => {
  const past = harness({}, { standing: { ...STANDING, stateType: "started" } });
  await past.run(assigned);
  assert.deepEqual(past.log.transitions, []);
  const noWay = harness({ transition: async () => false });
  await noWay.run(assigned);
  assert.equal(noWay.log.awaited, 1, "the session runs regardless");
});

test("every refusal says why, and nothing starts", async () => {
  const cases: [string, Partial<JiraAgentDeps>, Setup, RegExp][] = [
    ["not connected", {}, { scope: null }, /isn't connected/],
    ["not linked", { linkedOwner: async () => null }, {}, /Link your Jira account.*\/api\/integrations\/jira\/link/],
    ["not a member", { triageActor: async () => null }, {}, /aren't in the Outrunner org/],
    ["no repos", { triageActor: async (u) => actor(u, []) }, {}, /can't read any repository/],
  ];
  for (const [name, over, setup, said] of cases) {
    const h = harness(over, setup);
    await h.run(assigned);
    assert.match(h.log.comments[0] ?? "", said, name);
    assert.deepEqual(h.log.started, [], name);
    assert.equal(h.log.released, 1, name);
  }
});

test("a rule's session: off says so, past the cap says so, then it runs as the creator, never the reporter", async () => {
  const off = harness();
  await off.run(rule);
  assert.deepEqual(off.log.comments, [JIRA_REPLIES.rulesOff]);

  const on = { scope: scope({ acceptRuleSessions: true }) };
  const capped = harness({ claimRuleSession: async () => false }, on);
  await capped.run(rule);
  assert.deepEqual(capped.log.comments, [jiraCapReply(20)]);

  const runs = harness({}, on);
  await runs.run(rule);
  assert.equal(runs.log.started[0]?.userId, "ana-user");

  const bot = harness({}, { ...on, standing: { ...STANDING, creatorId: null } });
  await bot.run(rule);
  assert.deepEqual(bot.log.comments, [JIRA_REPLIES.noPerson]);
  assert.deepEqual(bot.log.started, []);

  const ownIssue = harness({}, { ...on, standing: { ...STANDING, creatorId: "app" } });
  await ownIssue.run(rule);
  assert.deepEqual(ownIssue.log.comments, [JIRA_REPLIES.noPerson]);

  const unlinked = harness({}, { ...on, standing: { ...STANDING, creatorId: "zed" } });
  await unlinked.run(rule);
  assert.match(unlinked.log.comments[0] ?? "", /Link your Jira account/);
  assert.deepEqual(unlinked.log.started, []);
});

test("repo order: a tag in the comment, then the issue's, then the item's, then the default", async () => {
  const tagged = harness();
  await tagged.run(mention("do it [repo=acme/api]"));
  assert.equal(tagged.log.started[0]?.projectId, API.id);
  const ofItem = harness({}, { item: item({ projectId: API.id }) });
  await ofItem.run(assigned);
  assert.equal(ofItem.log.started[0]?.projectId, API.id);
  const unreadable = harness({ projects: async () => [WEB] });
  await unreadable.run(mention("[repo=acme/api]"));
  assert.equal(unreadable.log.started[0]?.projectId, WEB.id, "a repo they can't read is skipped");
});

test("no repo settled: it asks, lists them, remembers the prompt, and starts on the asker's reply", async () => {
  const none = { scope: scope({ defaultProjectId: null }) };
  const h = harness({}, none);
  await h.run(mention("please"));
  assert.match(h.log.comments[0] ?? "", /Which repository[\s\S]*repo=owner\/name[\s\S]*acme\/web[\s\S]*acme\/api/);
  assert.equal(h.log.saved[0]?.stage, "awaiting_repo");
  assert.match(h.log.saved[0]?.prompt ?? "", /please/);
  assert.deepEqual(h.log.started, []);

  const waiting = row({ stage: "awaiting_repo", prompt: "The first prompt" });
  const reply: JiraTrigger = { kind: "reply", issueId: ISSUE, actor: { id: "ana", name: "Ana", kind: "person" }, text: "repo=acme/api" };
  const answered = harness({}, { ...none, row: waiting });
  await answered.run(reply);
  assert.equal(answered.log.started[0]?.projectId, API.id);
  assert.equal(answered.log.started[0]?.prompt, "The first prompt");

  const wrong = harness({}, { ...none, row: waiting });
  await wrong.run({ ...reply, text: "repo=acme/nope" });
  assert.match(wrong.log.comments[0] ?? "", /isn't one of the repositories/);
  assert.deepEqual(wrong.log.started, []);
});

test("a repo= comment from anyone else, or with nothing asked, does nothing and spends no one's allowance", async () => {
  const reply: JiraTrigger = { kind: "reply", issueId: ISSUE, actor: { id: "ben", name: "Ben", kind: "person" }, text: "repo=acme/api" };
  const other = harness({}, { row: row({ stage: "awaiting_repo" }) });
  await other.run(reply);
  assert.deepEqual(other.log.started, []);
  assert.deepEqual(other.log.comments, []);
  const notAsked = harness({}, { row: row({ stage: "working" }) });
  await notAsked.run({ ...reply, actor: { ...reply.actor, id: "ana" } });
  assert.deepEqual(notAsked.log.started, []);
  assert.deepEqual(notAsked.log.comments, []);
});

test("mentioned again with a session: that session hears it, and the relay waits", async () => {
  const session = { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "ready" };
  const h = harness({}, { row: row({ workspaceId: "w" }), session });
  await h.run(mention("and the tests"));
  assert.deepEqual(h.log.sent, ["Ana (in Jira): and the tests"]);
  assert.deepEqual(h.log.started, []);
  assert.equal(h.log.awaited, 1);
  assert.equal(h.log.saved[0]?.stage, "working");
});

test("someone else's live session isn't taken over; write on its repo may steer", async () => {
  const session = { id: "w", ownerId: "ben-user", projectId: WEB.id, status: "ready" };
  const read = harness({}, { row: row({ workspaceId: "w" }), session });
  await read.run(mention("hey"));
  assert.deepEqual(read.log.comments, [JIRA_REPLIES.cantSteer]);
  assert.deepEqual(read.log.started, []);
  const write = harness({ level: async () => "write" }, { row: row({ workspaceId: "w" }), session });
  await write.run(mention("hey"));
  assert.equal(write.log.sent.length, 1);
});

test("assigned to an issue whose session can't be reached: a new one starts", async () => {
  const session = { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "archived" };
  const h = harness({ send: async () => false }, { item: item({ workspaceId: "w" }), session });
  await h.run(assigned);
  assert.equal(h.log.started.length, 1);
  const archived = harness({}, { item: item({ workspaceId: "w" }), session: { ...session, ownerId: "ben-user" } });
  await archived.run(assigned);
  assert.equal(archived.log.started.length, 1, "an archived one isn't anyone's to protect");
});

test("only one event acts on an issue: a mention while it's held says so, and an assign needs no word", async () => {
  const held = { claim: async () => false };
  const mentioned = harness(held);
  await mentioned.run(mention("hey"));
  assert.deepEqual(mentioned.log.comments, [JIRA_REPLIES.busy]);
  assert.deepEqual(mentioned.log.started, []);
  assert.equal(mentioned.log.released, 0, "not ours to let go");
  const again = harness(held);
  await again.run(assigned);
  assert.deepEqual(again.log.comments, []);
});

test("a failure is said on the issue, as nothing makes Jira deliver it again, and the hold goes", async () => {
  const h = harness({ standing: async () => assert.fail("boom") });
  await h.run(assigned);
  assert.match(h.log.comments[0] ?? "", /Something went wrong/);
  assert.equal(h.log.released, 1);
});

test("a session that can't start: the row stops, the issue and item say why, and the status stays", async () => {
  const h = harness({ start: async () => ({ workspaceId: null, status: "refused", errorMessage: "No allowance left." }) });
  await h.run(assigned);
  assert.equal(h.log.stopped, 1);
  assert.match(h.log.comments[0] ?? "", /couldn't start: No allowance left/);
  assert.match(h.log.notes[0]?.body ?? "", /No allowance left/);
  assert.deepEqual(h.log.transitions, []);
  assert.equal(h.log.awaited, 0);
});

test("a model tag picks one, and an unknown one says so and runs the default", async () => {
  const unknown = harness();
  await unknown.run(mention("[model=nope] go"));
  assert.match(unknown.log.comments[0] ?? "", /no model called nope/);
  assert.equal(unknown.log.started[0]?.model, undefined);
});

test("the first prompt has the issue, its link and what was asked", () => {
  const prompt = jiraFirstPrompt(INSTALL, STANDING, mention("please look"));
  assert.match(prompt, /^Work on Jira issue ENG-1: Fix it/);
  assert.match(prompt, /https:\/\/acme\.atlassian\.net\/browse\/ENG-1/);
  assert.match(prompt, /Steps/);
  assert.match(prompt, /Ana said in Jira: please look/);
  assert.doesNotMatch(jiraFirstPrompt(INSTALL, STANDING, assigned), /said in Jira/);
});

// --- Findings it shares with Linear, and J4, J6

test("unassigned during setup: the row stays stopped, nothing's linked up, and the session is interrupted once up", async () => {
  const h: ReturnType<typeof harness> = harness({
    start: async (start) => {
      h.log.started.push(start);
      await h.deps.stopRow("install", ISSUE);
      await start.onCreated?.("w-new");
      return { workspaceId: "w-new", status: "ready" } as ServerSessionResult;
    },
  });
  await h.run(assigned);
  assert.equal(h.current()?.stage, "stopped", "not saved back to working");
  assert.equal(h.current()?.workspaceId, "w-new");
  assert.equal(h.log.watches, 0);
  assert.deepEqual(h.log.comments, [], "nothing more goes to Jira");
  assert.deepEqual(h.log.transitions, []);
  assert.deepEqual(h.log.interrupted, ["w-new"]);
  assert.equal(h.log.awaited, 0);
});

test("a slot goes only as a rule's session really starts", async () => {
  const on = { scope: scope({ acceptRuleSessions: true }) };
  const noCreator = harness({}, { ...on, standing: { ...STANDING, creatorId: null } });
  await noCreator.run(rule);
  assert.equal(noCreator.log.slots, 0);
  const unlinked = harness({ linkedOwner: async () => null }, on);
  await unlinked.run(rule);
  assert.equal(unlinked.log.slots, 0);
  const steering = harness({}, { ...on, item: item({ workspaceId: "w" }), session: { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "ready" } });
  await steering.run(rule);
  assert.equal(steering.log.slots, 1, "work a rule started counts, on what its runner owns");
  assert.equal(steering.log.sent.length, 1);
  assert.equal(steering.log.started.length, 0);
  const someoneElses = harness({}, { ...on, item: item({ workspaceId: "w" }), session: { id: "w", ownerId: "ben-user", projectId: WEB.id, status: "ready" } });
  await someoneElses.run(rule);
  assert.equal(someoneElses.log.sent.length, 0, "it may be on their own keys");
  assert.equal(someoneElses.log.slots, 0);
  const steerCapped = harness({ claimRuleSession: async () => false }, { ...on, item: item({ workspaceId: "w" }), session: { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "ready" } });
  await steerCapped.run(rule);
  assert.equal(steerCapped.log.sent.length, 0);

  const asking = harness({}, { scope: scope({ acceptRuleSessions: true, defaultProjectId: null }) });
  await asking.run(rule);
  assert.equal(asking.log.slots, 0, "asked which repo");
  assert.equal(asking.current()?.ruleStarted, true);
  await asking.run({ kind: "reply", issueId: ISSUE, actor: { id: "ana", name: "Ana", kind: "person" }, text: "repo=acme/web" });
  assert.equal(asking.log.slots, 1, "taken once it starts");
  assert.equal(asking.log.started.length, 1);

  const runs = harness({}, on);
  await runs.run(rule);
  assert.equal(runs.log.slots, 1);
});

test("a rule doesn't undo a decision made here, and spends nothing; a person may", async () => {
  for (const status of ["declined", "duplicate"] as const) {
    const h = harness({}, { scope: scope({ acceptRuleSessions: true }), item: item({ status }) });
    await h.run(rule);
    assert.deepEqual(h.log.comments, [JIRA_REPLIES.ruleDeclined], status);
    assert.deepEqual(h.log.started, [], status);
    assert.equal(h.log.slots, 0, status);
  }
  const person = harness({}, { item: item({ status: "declined" }) });
  await person.run(assigned);
  assert.equal(person.log.started.length, 1);
});

test("J4: a portal customer's @mention gets a reply, and never runs as the issue's creator", async () => {
  const h = harness({}, { scope: scope({ acceptRuleSessions: true }) });
  await h.run({ kind: "mentioned", issueId: ISSUE, actor: { id: "customer", name: "C", kind: "other" }, text: "please" });
  assert.deepEqual(h.log.comments, [JIRA_REPLIES.notAPerson]);
  assert.deepEqual(h.log.started, []);
  assert.equal(h.log.slots, 0);
});

test("J6: the owner's answer that @mentions us is the answer, with the saved prompt, not asked again", async () => {
  const waiting = row({ stage: "awaiting_repo", prompt: "The first prompt" });
  const none = { scope: scope({ defaultProjectId: null }), row: waiting };
  const h = harness({}, none);
  await h.run(mention("@someone repo=acme/api"));
  assert.equal(h.log.started[0]?.projectId, API.id);
  assert.equal(h.log.started[0]?.prompt, "The first prompt");
  assert.deepEqual(h.log.comments.filter((c) => /Which repository/.test(c)), []);

  const other = harness({}, none);
  await other.run({ kind: "mentioned", issueId: ISSUE, actor: { id: "ben", name: "Ben", kind: "person" }, text: "repo=acme/api" });
  // Someone else's isn't the answer, and doesn't take the question over.
  assert.deepEqual(other.log.started, []);
  assert.deepEqual(other.log.comments, [JIRA_REPLIES.notYours]);
  assert.deepEqual(other.log.saved, []);
});

test("the branch and first prompt carry the issue's key", async () => {
  const h = harness();
  await h.run(assigned);
  assert.equal(h.log.started[0]?.branch, "ENG-1-fix-it", "Jira wants its key uppercase");
  assert.match(h.log.started[0]?.prompt ?? "", /Keep ENG-1 in any branch you name/);
  const keyless = harness({}, { standing: { ...STANDING, key: null } });
  await keyless.run(assigned);
  assert.equal(keyless.log.started[0]?.branch, undefined);
});

test("the hold goes before the watch, and a failed watch doesn't matter", async () => {
  const order: string[] = [];
  const h = harness({
    release: async () => void order.push("released"),
    watchReply: async () => void order.push("watching"),
  });
  await h.run(assigned);
  assert.deepEqual(order, ["released", "watching"]);
  const session = { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "ready" };
  const steer: string[] = [];
  const again = harness({ release: async () => void steer.push("released"), watchReply: async () => void steer.push("watching") }, { row: row({ workspaceId: "w" }), session });
  await again.run(mention("more"));
  assert.deepEqual(steer, ["released", "watching"]);
  const error = console.error;
  console.error = () => undefined;
  try {
    await harness({ watchReply: async () => assert.fail("boom") }).run(assigned);
  } finally {
    console.error = error;
  }
});

test("every session that isn't live counts as gone", async () => {
  for (const status of ["archiving", "destroying", "destroyed"]) {
    const mine = harness({}, { row: row({ workspaceId: "w" }), session: { id: "w", ownerId: "ana-user", projectId: WEB.id, status } });
    await mine.run(mention("more"));
    assert.deepEqual(mine.log.sent, [], status);
    assert.equal(mine.log.started.length, 1, status);
    const theirs = harness({}, { row: row({ workspaceId: "w" }), session: { id: "w", ownerId: "ben-user", projectId: WEB.id, status } });
    await theirs.run(mention("more"));
    assert.equal(theirs.log.started.length, 1, status);
  }
});

test("the comment a waiting prompt quotes is noted, for an edit or delete to find", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: null }) });
  await h.run({ ...mention("my secret"), commentId: "c9" });
  assert.equal(h.current()?.commentId, "c9");
});

test("not linked: what they asked is kept, and linking carries it on without asking again", async () => {
  let linked = false;
  const over = { linkedOwner: async (_i: string, id: string) => (linked && id === "ana" ? "ana-user" : null) };
  const h = harness(over);
  await h.run({ ...mention("fix it [repo=acme/api]"), commentId: "c9" });
  assert.match(h.log.comments[0] ?? "", /Link your Jira account to Outrunner, and this carries on: .*\/api\/integrations\/jira\/link/);
  const kept = h.current() as JiraRow;
  assert.equal(kept.stage, "awaiting_link");
  assert.equal(kept.askedUser, "ana");
  assert.equal(kept.commentId, "c9");
  assert.equal(h.log.started.length, 0);

  linked = true;
  await resumeJiraAfterLink(INSTALL, kept, h.deps);
  assert.equal(h.log.started.length, 1);
  assert.equal(h.log.started[0]?.userId, "ana-user");
  assert.equal(h.log.started[0]?.projectId, API.id, "its tag still counts");
  assert.equal(h.log.started[0]?.prompt, kept.prompt, "as first asked");
});

test("a rule's kept ask carries on as a rule's: the setting and cap still apply", async () => {
  let linked = false;
  const h = harness({ linkedOwner: async (_i, id) => (linked && id === "ana" ? "ana-user" : null) }, { scope: scope({ acceptRuleSessions: true }) });
  await h.run(rule);
  assert.equal(h.log.slots, 0);
  const kept = h.current() as JiraRow;
  assert.equal(kept.ruleStarted, true);
  assert.equal(kept.askedUser, "ana", "the creator");
  linked = true;
  await resumeJiraAfterLink(INSTALL, kept, h.deps);
  assert.equal(h.log.slots, 1);
  assert.equal(h.log.started.length, 1);
});

test("resuming on an issue closed since says so and doesn't start; one gone says nothing", async () => {
  const waiting = row({ stage: "awaiting_link", prompt: "P", askedUser: "ana", openWhenAsked: true });
  const closed = harness({}, { row: waiting, standing: { ...STANDING, open: false, stateType: "completed" } });
  await resumeJiraAfterLink(INSTALL, waiting, closed.deps);
  assert.deepEqual(closed.log.comments, [JIRA_REPLIES.closedSince]);
  assert.deepEqual(closed.log.started, []);
  assert.equal(closed.log.stopped, 1);
  const gone = harness({}, { row: waiting, standing: null });
  await resumeJiraAfterLink(INSTALL, waiting, gone.deps);
  assert.deepEqual(gone.log.comments, []);
  assert.deepEqual(gone.log.started, []);
});

test("Jira: refused, fixed, assigned again: it arrives as its own event, and no row stands in the way", async () => {
  let connected = false;
  const h = harness({ scopeForTeam: async () => (connected ? scope() : null) });
  await h.run(assigned);
  assert.deepEqual(h.log.comments, [JIRA_REPLIES.notConnected]);
  assert.deepEqual(h.log.started, []);
  connected = true;
  await h.run(assigned);
  assert.equal(h.log.started.length, 1);
  assert.equal(h.log.claims, 2);
});

test("Jira: a stale row of any stage doesn't block an assign", async () => {
  for (const stage of ["stopped", "awaiting_link", "awaiting_repo"] as const) {
    const h = harness({}, { row: row({ stage, prompt: "Old", askedUser: "ana" }) });
    await h.run(assigned);
    assert.equal(h.log.started.length, 1, stage);
    assert.doesNotMatch(h.log.started[0]?.prompt ?? "", /^Old$/, `${stage}: as asked now, not then`);
  }
});

test("Jira: someone unlinked doesn't take over the issue's one row", async () => {
  const live = row({ workspaceId: "w", ownerId: "ana-user" });
  const h = harness({}, { row: live, session: { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "ready" } });
  await h.run({ kind: "mentioned", issueId: ISSUE, actor: { id: "zed", name: "Zed", kind: "person" }, text: "hey" });
  assert.match(h.log.comments[0] ?? "", /Link your Jira account to Outrunner, then mention/);
  assert.deepEqual(h.log.saved, []);
  assert.deepEqual(h.current(), live);

  const waiting = row({ stage: "awaiting_repo", prompt: "P" });
  const asked = harness({}, { row: waiting });
  await asked.run({ kind: "assigned", issueId: ISSUE, actor: { id: "zed", name: "Zed", kind: "person" }, text: null });
  assert.deepEqual(asked.log.saved, []);
  assert.deepEqual(asked.current(), waiting);

  const free = harness({}, { row: row({ stage: "stopped" }) });
  await free.run({ kind: "assigned", issueId: ISSUE, actor: { id: "zed", name: "Zed", kind: "person" }, text: null });
  assert.equal(free.current()?.stage, "awaiting_link", "a row nobody's using can carry it on");
});

test("a tag counts from their own comment, and never the description: anyone who can edit it can edit that", async () => {
  const run = async (trigger: JiraTrigger, standing: Partial<JiraIssueStanding>) => {
    const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }), standing: { ...STANDING, ...standing } });
    await h.run(trigger);
    return h.log.started[0]?.projectId;
  };
  assert.equal(await run(mention("[repo=acme/api]"), {}), API.id, "their comment");
  assert.equal(await run(assigned, { description: "[repo=acme/api]" }), WEB.id, "even of an issue they made");
  assert.equal(await run(assigned, { description: "[repo=acme/api]", creatorId: "zed" }), WEB.id, "or someone else did");
  const model = harness({}, { scope: scope({ defaultProjectId: WEB.id }), standing: { ...STANDING, description: `[model=${OUTRUNNER_MODELS[0].id}]` } });
  await model.run(assigned);
  assert.equal(model.log.started[0]?.model, undefined, "nor a model on their allowance");
});

test("asked to link: only what they said names a repository, the issue's own text doesn't", async () => {
  const h = harness({ linkedOwner: async () => null }, { scope: scope({ defaultProjectId: WEB.id }), standing: { ...STANDING, description: "[repo=acme/api]", creatorId: "zed" } });
  await h.run(mention("please"));
  assert.equal(h.current()?.askText, "please");
  assert.match(h.current()?.prompt ?? "", /\[repo=acme\/api\]/, "the prompt has it");
});

test("told something as it's assigned away: that stands, and it's interrupted", async () => {
  const session = { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "ready" };
  const h = harness({ send: async () => { await h.deps.stopRow("install", ISSUE); return true; } }, { row: row({ stage: "working", workspaceId: "w" }), session });
  await h.run(mention("and this"));
  assert.equal(h.current()?.stage, "stopped");
  assert.deepEqual(h.log.interrupted, ["w"]);
  assert.equal(h.log.watches, 0);
  const stays = harness({ send: async () => false }, { row: row({ stage: "stopped", workspaceId: null }), item: item({ workspaceId: "w" }), session, scope: scope({ defaultProjectId: null }) });
  await stays.run(mention("and this"));
  assert.equal(stays.log.saved[1]?.stage, "stopped", "put back, before asking where else it could go");
});

test("a mention while it's being set up: busy, and no second one starts", async () => {
  const h = harness({ send: async () => assert.fail("nothing can reach it") }, { item: item({ workspaceId: "w" }), session: { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "creating" } });
  await h.run(mention("and this"));
  assert.deepEqual(h.log.started, []);
  assert.equal(h.log.comments.at(-1), JIRA_REPLIES.busy);
});

test("linked while something's under way: they hear so", async () => {
  const h = harness({ claim: async () => false }, { row: row({ stage: "awaiting_link", askedUser: "ana" }) });
  await resumeJiraAfterLink(INSTALL, row({ stage: "awaiting_link", askedUser: "ana" }), h.deps);
  assert.equal(h.log.comments.at(-1), JIRA_REPLIES.busy);
});

test("which repo, answered once the issue's closed: it's over", async () => {
  const h = harness({}, { row: row({ stage: "awaiting_repo", ownerId: "ana-user", workspaceId: null, openWhenAsked: true }), standing: { ...STANDING, open: false }, scope: scope({ defaultProjectId: null }) });
  await h.run({ kind: "reply", issueId: ISSUE, actor: { id: "ana", name: "Ana", kind: "person" }, text: "repo=acme/web" });
  assert.deepEqual(h.log.started, []);
  assert.equal(h.current()?.stage, "stopped");
  assert.equal(h.log.comments.at(-1), JIRA_REPLIES.closedSince);
});

test("closed while it started: its turn stops and the item says so. Already closed when asked, it goes on", async () => {
  let looks = 0;
  const closes = harness({ standing: async () => ({ ...STANDING, open: ++looks === 1 }) }, { item: item() });
  await closes.run(assigned);
  assert.deepEqual(closes.log.interrupted, ["w-new"]);
  assert.equal(closes.current()?.stage, "stopped");
  assert.match(closes.log.notes.at(-1)?.body ?? "", /closed as its session was starting/);
  assert.equal(closes.log.awaited, 0);

  const already = harness({}, { standing: { ...STANDING, open: false } });
  await already.run(assigned);
  assert.deepEqual(already.log.interrupted, []);
  assert.equal(already.log.started.length, 1);
});

test("asked about an issue already closed: answering or linking carries on, not told it's closed since", async () => {
  const closed = { ...STANDING, open: false };
  const repo = harness({}, { standing: closed, scope: scope({ defaultProjectId: null }) });
  await repo.run(assigned);
  assert.equal(repo.current()?.stage, "awaiting_repo");
  assert.equal(repo.current()?.openWhenAsked, false);
  await repo.run({ kind: "reply", issueId: ISSUE, actor: { id: "ana", name: "Ana", kind: "person" }, text: "repo=acme/web" });
  assert.equal(repo.log.started.length, 1);

  let linked = false;
  const link = harness({ linkedOwner: async () => (linked ? "ana-user" : null) }, { standing: closed });
  await link.run(assigned);
  const asked = link.current() as JiraRow;
  assert.equal(asked.stage, "awaiting_link");
  assert.equal(asked.openWhenAsked, false);
  linked = true;
  await resumeJiraAfterLink(INSTALL, asked, link.deps);
  assert.equal(link.log.started.length, 1);
});

test("asked while it was open, then closed: that's what's refused", async () => {
  let open = true;
  const h = harness({ standing: async () => ({ ...STANDING, open }) }, { scope: scope({ defaultProjectId: null }) });
  await h.run(assigned);
  assert.equal(h.current()?.openWhenAsked, true);
  open = false;
  await h.run({ kind: "reply", issueId: ISSUE, actor: { id: "ana", name: "Ana", kind: "person" }, text: "repo=acme/web" });
  assert.deepEqual(h.log.started, []);
  assert.equal(h.log.comments.at(-1), JIRA_REPLIES.closedSince);
});

test("a rule on an archived session someone else owns: it's gone, so a new one starts on its own slot", async () => {
  const on = { scope: scope({ acceptRuleSessions: true }), item: item({ workspaceId: "w" }) };
  for (const level of ["write", "read"] as const) {
    const h = harness({ level: async () => level }, { ...on, session: { id: "w", ownerId: "ben-user", projectId: WEB.id, status: "archived" } });
    await h.run(rule);
    assert.deepEqual(h.log.sent, []);
    assert.equal(h.log.started.length, 1);
    assert.equal(h.log.slots, 1);
  }
  const live = harness({ level: async () => "write" }, { ...on, session: { id: "w", ownerId: "ben-user", projectId: WEB.id, status: "ready" } });
  await live.run(rule);
  assert.deepEqual(live.log.started, [], "a live one isn't replaced");
  assert.equal(live.log.slots, 0);
});

// --- A stop can't be written over: each of these interleaves one where it could land.

test("assigned away while it's deciding: a row that only read as stopped doesn't get written over", async () => {
  // A stub, as claiming leaves.
  const stub = row({ stage: "stopped", workspaceId: null, ownerId: null, orgId: null });
  const stopping = (h: () => ReturnType<typeof harness>) => async () => {
    await h().deps.stopRow("install", ISSUE);
    return [WEB, API];
  };
  const start: ReturnType<typeof harness> = harness({ projects: stopping(() => start) }, { row: stub });
  await start.run(assigned);
  assert.deepEqual(start.log.started, []);
  assert.equal(start.current()?.stage, "stopped");
  const asking: ReturnType<typeof harness> = harness({ projects: stopping(() => asking) }, { row: stub, scope: scope({ defaultProjectId: null }) });
  await asking.run(assigned);
  assert.equal(asking.current()?.stage, "stopped");
  assert.equal(asking.log.comments.some((c) => /Which repository/.test(c)), false);
  const linking: ReturnType<typeof harness> = harness(
    {
      linkedOwner: async () => {
        await linking.deps.stopRow("install", ISSUE);
        return null;
      },
    },
    { row: stub },
  );
  await linking.run(assigned);
  assert.equal(linking.current()?.stage, "stopped");
  assert.equal(linking.log.comments.length, 0);
});

test("assigned away before this looked: Jira says so, and nothing starts", async () => {
  const h = harness({}, { standing: { ...STANDING, assigneeId: "ben" } });
  await h.run(assigned);
  assert.deepEqual(h.log.started, []);
  assert.deepEqual(h.log.comments, []);
  const none = harness({}, { standing: { ...STANDING, assigneeId: null } });
  await none.run(rule);
  assert.deepEqual(none.log.comments, []);
  // A mention doesn't need an assignment, nor what they asked before linking.
  const mentioned = harness({}, { standing: { ...STANDING, assigneeId: "ben" } });
  await mentioned.run(mention("please"));
  assert.equal(mentioned.log.started.length, 1);
  const waiting = row({ stage: "awaiting_link", workspaceId: null, askedUser: "ana", prompt: "P" });
  const resumed = harness({}, { row: waiting, standing: { ...STANDING, assigneeId: "ben" } });
  await resumeJiraAfterLink(INSTALL, waiting, resumed.deps);
  assert.equal(resumed.log.started.length, 1);
});

test("a failed send puts back exactly what was there", async () => {
  const waiting = row({ stage: "awaiting_link", workspaceId: null, prompt: "As first asked", askedUser: "ana" });
  const h = harness({ send: async () => false, projects: async () => [] }, { row: waiting, item: item({ workspaceId: "w" }), session: { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "ready" } });
  await resumeJiraAfterLink(INSTALL, waiting, h.deps);
  assert.equal(h.current()?.stage, "awaiting_link");
  assert.equal(h.current()?.prompt, "As first asked");
  assert.equal(h.current()?.workspaceId, null);
});

test("a slot taken for what's still waiting isn't taken again", async () => {
  const session = { id: "w", ownerId: "ana-user", projectId: WEB.id, status: "ready" };
  const h = harness({ send: async () => false }, { scope: scope({ acceptRuleSessions: true, defaultProjectId: null }), item: item({ workspaceId: "w" }), session });
  await h.run(rule);
  assert.equal(h.log.slots, 1);
  assert.equal(h.current()?.stage, "awaiting_repo");
  assert.equal(h.current()?.slotTaken, true);
  await h.run({ kind: "reply", issueId: ISSUE, actor: { id: "ana", name: "Ana", kind: "person" }, text: "repo=acme/web" });
  assert.equal(h.log.started.length, 1);
  assert.equal(h.log.slots, 1, "the answer doesn't take another");
});

test("what was said before the question still counts once it's answered", async () => {
  const known = OUTRUNNER_MODELS[0].id;
  const h = harness({}, { scope: scope({ defaultProjectId: null }) });
  await h.run(mention(`please use [model=${known}]`));
  assert.equal(h.current()?.stage, "awaiting_repo");
  assert.match(h.current()?.askText ?? "", /model=/);
  await h.run({ kind: "reply", issueId: ISSUE, actor: { id: "ana", name: "Ana", kind: "person" }, text: "repo=acme/web" });
  assert.equal(h.log.started[0]?.model, known);
  assert.equal(h.log.started[0]?.projectId, WEB.id);

  // A rule's words aren't anyone's.
  const ruled = harness({}, { scope: scope({ acceptRuleSessions: true, defaultProjectId: null }) });
  await ruled.run({ kind: "mentioned", issueId: ISSUE, actor: { id: "automation", name: "A", kind: "rule" }, text: `[model=${known}]` });
  assert.equal(ruled.current()?.askText, null);
});
