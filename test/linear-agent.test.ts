import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRow } from "@/lib/db/linear-agent";
import type { TrackerInstallation, TrackerScope } from "@/lib/db/trackers";
import type { TrackerFiling, TrackerNote } from "@/lib/db/work-items";
import { OUTRUNNER_MODELS } from "@/lib/runtime/session-models";
import type { ServerSessionResult, ServerSessionStart } from "@/lib/session/server-session";
import type { LinearActivity, LinearSignal } from "@/lib/trackers/linear";
import {
  type AgentDeps,
  type AgentPayload,
  bestSuggestion,
  capReply,
  firstPrompt,
  handleAgentEvent,
  pickModel,
  pickRepo,
  REPLIES,
  repoFromReply,
  resumeAfterLink,
  askOf,
  handleRedelegated,
  withoutEscapes,
} from "@/lib/trackers/linear-agent";
import type { TriageActor } from "@/lib/triage/access";
import type { WorkItem } from "@/lib/triage/work-items";

const ORG = "org-a";
const TEAM = "team-1";
const AGENT = "agent-1";
const ISSUE = "issue-1";
const WEB = { id: "11111111-1111-4111-8111-111111111111", fullName: "acme/web" };
const API = { id: "22222222-2222-4222-8222-222222222222", fullName: "acme/api" };
const INSTALL: TrackerInstallation = { id: "install", provider: "linear", externalId: "lin-org", siteUrl: null, name: "Acme", appUserId: "app-user", disconnected: false };

function scope(over: Partial<TrackerScope> = {}): TrackerScope {
  return {
    id: "scope-1",
    installationId: INSTALL.id,
    orgId: ORG,
    externalTeamId: TEAM,
    name: "Eng",
    setBy: "admin",
    stateMap: { started: "st-progress", inReview: "st-review", done: null, blocked: null },
    defaultProjectId: null,
    acceptRuleSessions: false,
    ruleSessionsPerDay: 20,
    ...over,
  };
}

function actor(userId: string, projects = [WEB.id, API.id]): TriageActor {
  return { userId, orgId: ORG, orgLevel: "write", levels: new Map(projects.map((id) => [id, "read" as const])) };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "item-1",
    number: 1,
    projectId: null,
    title: "T",
    body: "",
    status: "triage",
    source: "linear",
    sourceUrl: null,
    sourceRef: `linear:${ISSUE}`,
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

function harness(over: Partial<AgentDeps> = {}, setup: { scope?: TrackerScope | null; item?: WorkItem | null; row?: AgentRow | null; held?: Map<string, string> } = {}) {
  const log = {
    said: [] as { content: LinearActivity; signal?: LinearSignal }[],
    urls: [] as { label: string; url: string }[],
    states: [] as string[],
    started: [] as ServerSessionStart[],
    sent: [] as { workspaceId: string; text: string }[],
    stopped: [] as string[],
    filed: [] as { actor: string; filing: TrackerFiling; installationId: string }[],
    linked: [] as { itemId: string; workspaceId: string; projectId: string }[],
    notes: [] as TrackerNote[],
    awaited: [] as string[],
    deferred: [] as (() => Promise<unknown>)[],
    stoppedRows: [] as string[],
    watches: [] as { sentAt: number; baselineActivity: number | null }[],
    slots: 0,
    claims: [] as string[],
    released: [] as string[],
  };
  const held = setup.held ?? new Map<string, string>();
  let row = setup.row ?? null;
  const rows: AgentRow[] = [];
  const deps: AgentDeps = {
    say: async (_i, _a, content, signal) => void log.said.push({ content, signal }),
    addUrl: async (_i, _a, url) => void log.urls.push(url),
    setIssueState: async (_i, _issue, state) => void log.states.push(state),
    standing: async () => ({ teamId: TEAM, delegateId: "app-user", open: true, stateType: "unstarted" }),
    creator: async () => ({ id: "ana", name: "Ana" }),
    suggestions: async () => [],
    scopeForTeam: async () => (setup.scope === undefined ? scope() : setup.scope),
    claimRuleSession: async () => {
      log.slots += 1;
      return true;
    },
    linkedOwner: async (_i, id) => (id === "ana" ? "ana-user" : null),
    triageActor: async (userId) => actor(userId),
    projects: async () => [WEB, API],
    level: async () => "read",
    item: async () => setup.item ?? null,
    file: async (a, filing, installationId) => {
      log.filed.push({ actor: a.userId, filing, installationId });
      return item();
    },
    linkItem: async (_o, itemId, session) => void log.linked.push({ itemId, ...session }),
    addNote: async (_o, _i, note) => void log.notes.push(note),
    row: async () => row,
    latestRow: async () => row,
    // As saveAgentRow does.
    saveRow: async (next, seen, options) => {
      if (!seen) {
        if (row) return false;
      } else {
        if (seen.stage === "stopped" && next.stage !== "stopped" && !options?.restart) return false;
        if ((row?.stopMark ?? null) !== (seen.stopMark ?? null)) return false;
      }
      row = { ...next, stopMark: row?.stopMark ?? null };
      rows.push(row);
      return true;
    },
    setRowWorkspace: async (_id, workspaceId) => {
      if (row) row = { ...row, workspaceId };
    },
    stopRow: async (id) => {
      log.stoppedRows.push(id);
      if (row) row = { ...row, stage: "stopped", stopMark: `stop-${log.stoppedRows.length}` };
    },
    claimIssue: async (_i, issueId, holder) => {
      log.claims.push(holder);
      const current = held.get(issueId);
      if (current) return current;
      held.set(issueId, holder);
      return null;
    },
    releaseIssue: async (_i, issueId, holder) => {
      log.released.push(holder);
      if (held.get(issueId) === holder) held.delete(issueId);
    },
    session: async (id) => ({ id, ownerId: "ana-user", projectId: WEB.id, status: "ready" }),
    start: async (start) => {
      log.started.push(start);
      await start.onCreated?.("workspace-1");
      return { workspaceId: "workspace-1", status: "ready" } as ServerSessionResult;
    },
    send: async (_o, workspaceId, text) => {
      log.sent.push({ workspaceId, text });
      return true;
    },
    stop: async (_o, workspaceId) => {
      log.stopped.push(workspaceId);
      return true;
    },
    interruptWaitMs: 5,
    sendBaseline: async () => 1000,
    openWatch: async (_id, sent) => void log.watches.push(sent),
    watchReply: async (id) => void log.awaited.push(id),
    now: () => 5000,
    linkUrl: () => "https://app/api/integrations/linear/link",
    sessionUrl: (id) => `https://app/workspaces/${id}`,
    defer: (work) => void log.deferred.push(work),
    ...over,
  };
  const run = async () => {
    for (let i = 0; i < log.deferred.length; i++) await log.deferred[i]();
  };
  return { deps, log, run, rows: () => rows, current: () => row };
}

/** The shape from @linear/sdk 101.1.0's AgentSessionEventWebhookPayload. Delegation itself
 *  hasn't been seen from real Linear yet. */
function created(over: { session?: Record<string, unknown>; issue?: Record<string, unknown> | null } & Record<string, unknown> = {}): AgentPayload {
  const { session, issue, ...rest } = over;
  return {
    action: "created",
    appUserId: "app-user",
    promptContext: "<issue>Checkout breaks</issue>",
    agentSession: {
      id: AGENT,
      creatorId: "ana",
      creator: { id: "ana", name: "Ana" },
      issueId: ISSUE,
      issue: issue === null ? null : { id: ISSUE, identifier: "ENG-1", teamId: TEAM, title: "Checkout breaks", description: "On Safari", url: "https://linear.app/a/issue/ENG-1", ...issue },
      ...session,
    },
    ...rest,
  } as AgentPayload;
}

function prompted(body: string, over: Record<string, unknown> = {}): AgentPayload {
  return { ...created(), action: "prompted", agentActivity: { content: { type: "prompt", body }, userId: "ana", user: { name: "Ana" }, ...over } } as AgentPayload;
}

const said = (log: { said: { content: LinearActivity }[] }) => log.said.map((s) => s.content);

async function send(payload: AgentPayload, h: ReturnType<typeof harness>) {
  const result = await handleAgentEvent(INSTALL, payload, h.deps);
  await h.run();
  return result;
}

// --- What's said first

test("something is said before the webhook answers, and the slow part runs after", async () => {
  const h = harness();
  await handleAgentEvent(INSTALL, created(), h.deps);
  assert.deepEqual(said(h.log), [{ type: "thought", body: "Looking at this issue." }]);
  assert.equal(h.log.started.length, 0, "nothing started yet");
  assert.equal(h.log.deferred.length, 1);
});

test("if that first word can't be said, the webhook hears of it, for Linear to deliver again", async () => {
  const h = harness({
    say: async () => {
      throw new Error("no token");
    },
  });
  await assert.rejects(handleAgentEvent(INSTALL, created(), h.deps));
  assert.equal(h.log.deferred.length, 0);
});

test("an @mention outside an issue gets one reply", async () => {
  const h = harness();
  await send(created({ issue: null, session: { issueId: null } }), h);
  assert.deepEqual(said(h.log), [{ type: "response", body: REPLIES.issuesOnly }]);
  assert.equal(h.log.started.length, 0);
});

// --- Who it runs as

test("a delegation runs as the linked delegator, on a session, an item in progress, and in Linear", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created(), h);
  const start = h.log.started[0];
  assert.equal(start.userId, "ana-user");
  assert.equal(start.projectId, WEB.id);
  assert.equal(start.source, "linear");
  assert.equal(h.log.filed[0].filing.sourceRef, `linear:${ISSUE}`);
  assert.equal(h.log.filed[0].filing.sourceAuthor, "Ana");
  assert.equal(h.log.filed[0].installationId, INSTALL.id);
  assert.deepEqual(h.log.linked, [{ itemId: "item-1", workspaceId: "workspace-1", projectId: WEB.id }]);
  assert.deepEqual(h.log.urls, [{ label: "Outrunner session", url: "https://app/workspaces/workspace-1" }]);
  assert.deepEqual(h.log.states, ["st-progress"]);
  assert.deepEqual(h.log.awaited, [AGENT]);
  assert.equal(h.current()?.workspaceId, "workspace-1");
  assert.equal(h.current()?.stage, "working");
});

test("an unconnected team gets a reply, not silence", async () => {
  const h = harness({}, { scope: null });
  await send(created(), h);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.notConnected });
  assert.equal(h.log.started.length, 0);
});

test("an unlinked delegator is asked to link, naming them, and nothing starts", async () => {
  const h = harness({ linkedOwner: async () => null });
  await send(created(), h);
  const asked = h.log.said.at(-1);
  assert.equal(asked?.content.type, "elicitation");
  assert.deepEqual(asked?.signal, { signal: "auth", signalMetadata: { url: "https://app/api/integrations/linear/link", userId: "ana", providerName: "Outrunner" } });
  assert.equal(h.log.started.length, 0);
  assert.equal(h.current()?.stage, "awaiting_link");
});

test("someone linked but not in the org gets a reply", async () => {
  const h = harness({ triageActor: async () => null });
  await send(created(), h);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.notMember });
  assert.equal(h.log.started.length, 0);
});

// --- Rule-started

const byRule = () => created({ session: { creatorId: null, creator: null } });

test("a rule's delegation, with those off, gets one reply and takes nothing", async () => {
  let claims = 0;
  const h = harness({
    claimRuleSession: async () => {
      claims += 1;
      return true;
    },
  });
  await send(byRule(), h);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.rulesOff });
  assert.equal(claims, 0);
  assert.equal(h.log.started.length, 0);
});

test("a rule's delegation past the day's cap gets one reply, and nothing's queued", async () => {
  const h = harness({ claimRuleSession: async () => false }, { scope: scope({ acceptRuleSessions: true, ruleSessionsPerDay: 7, defaultProjectId: WEB.id }) });
  await send(byRule(), h);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: capReply(7) });
  assert.equal(h.log.started.length, 0);
});

test("a rule's delegation, with those on, runs as the issue's creator", async () => {
  const h = harness({}, { scope: scope({ acceptRuleSessions: true, defaultProjectId: WEB.id }) });
  await send(byRule(), h);
  assert.equal(h.log.started[0].userId, "ana-user");
});

test("our own app as the delegator counts as a rule", async () => {
  const h = harness();
  await send(created({ session: { creatorId: "app-user", creator: null } }), h);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.rulesOff });
});

test("a rule's delegation of an issue no person made is refused", async () => {
  for (const creator of [null, { id: "app-user", name: "Outrunner" }]) {
    const h = harness({ creator: async () => creator }, { scope: scope({ acceptRuleSessions: true }) });
    await send(byRule(), h);
    assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.noPerson });
    assert.equal(h.log.started.length, 0);
  }
});

test("a rule's delegation with its creator unlinked is asked to link, and nothing starts", async () => {
  const h = harness({ creator: async () => ({ id: "ben", name: "Ben" }) }, { scope: scope({ acceptRuleSessions: true }) });
  await send(byRule(), h);
  assert.equal(h.log.said.at(-1)?.signal?.signal, "auth");
  assert.equal(h.log.started.length, 0);
});

// --- Which repository

const readable = [WEB, API];
const pick = (over: Partial<Parameters<typeof pickRepo>[0]>) =>
  pickRepo({ comment: null, itemProjectId: null, defaultProjectId: null, guidance: [], readable, ...over });

test("the repo order: comment tag, issue tag, item, team default, guidance tag", () => {
  const everything = { comment: "[repo=acme/web]", itemProjectId: API.id, defaultProjectId: API.id, guidance: ["[repo=acme/api]"] };
  assert.equal(pick(everything), WEB);
  assert.equal(pick({ itemProjectId: WEB.id, defaultProjectId: API.id, guidance: ["[repo=acme/api]"] }), WEB);
  assert.equal(pick({ defaultProjectId: WEB.id, guidance: ["[repo=acme/api]"] }), WEB);
  assert.equal(pick({ guidance: ["nothing here", "[repo=acme/web]"] }), WEB);
  assert.equal(pick({}), null);
});

test("a repo the runner can't read doesn't count, and the next one in the order does", () => {
  assert.equal(pick({ comment: "[repo=acme/secret]", defaultProjectId: WEB.id }), WEB);
  assert.equal(pickRepo({ comment: null, itemProjectId: API.id, defaultProjectId: WEB.id, guidance: [], readable: [WEB] }), WEB);
  assert.equal(pickRepo({ comment: null, itemProjectId: null, defaultProjectId: API.id, guidance: [], readable: [WEB] }), null);
});

test("prose in guidance isn't read for repositories", () => {
  assert.equal(pick({ guidance: ["Our code lives in acme/web"] }), null);
});

test("Linear's suggestion counts only if it's sure, and readable", () => {
  assert.equal(bestSuggestion([{ repositoryFullName: "acme/web", confidence: 0.79 }], readable), null);
  assert.equal(bestSuggestion([{ repositoryFullName: "acme/web", confidence: 0.8 }], readable), WEB);
  assert.equal(bestSuggestion([{ repositoryFullName: "acme/secret", confidence: 0.99 }, { repositoryFullName: "ACME/API", confidence: 0.85 }], readable), API);
});

test("no confident repo asks, listing what the runner can read, and starts nothing", async () => {
  const h = harness({ triageActor: async (u) => actor(u, [WEB.id]) });
  await send(created(), h);
  const asked = h.log.said.at(-1);
  assert.deepEqual(asked?.signal, { signal: "select", signalMetadata: { options: [{ label: "acme/web", value: "acme/web" }] } });
  assert.equal(h.log.started.length, 0);
  assert.equal(h.current()?.stage, "awaiting_repo");
  assert.ok(h.current()?.prompt?.includes("Checkout breaks"));
});

test("Linear being unable to suggest just asks instead", async () => {
  const h = harness({
    suggestions: async () => {
      throw new Error("down");
    },
  });
  await send(created(), h);
  assert.equal(h.log.said.at(-1)?.signal?.signal, "select");
});

test("the answer to which repo starts the session, with the first prompt", async () => {
  const h = harness();
  await send(created(), h);
  h.log.deferred.length = 0;
  await send(prompted("acme/api"), h);
  assert.equal(h.log.started[0].projectId, API.id);
  assert.match(h.log.started[0].prompt, /Checkout breaks/);
});

test("an answer that isn't a repo they can use asks again", async () => {
  const h = harness();
  await send(created(), h);
  h.log.deferred.length = 0;
  await send(prompted("the frontend one"), h);
  assert.equal(h.log.started.length, 0);
  assert.equal(h.log.said.at(-1)?.content.body, REPLIES.notARepo);
});

test("repoFromReply reads a value, a tag, or a sentence, and prefers the longer name", () => {
  const web2 = { id: "w2", fullName: "acme/web-app" };
  assert.equal(repoFromReply("acme/web", readable), WEB);
  assert.equal(repoFromReply("[repo=acme/api]", readable), API);
  assert.equal(repoFromReply("let's use ACME/API please", readable), API);
  assert.equal(repoFromReply("acme/web-app", [WEB, web2]), web2);
  assert.equal(repoFromReply("nope", readable), null);
  assert.equal(repoFromReply(null, readable), null);
});

test("nothing readable at all says so", async () => {
  const h = harness({ triageActor: async (u) => actor(u, []) });
  await send(created(), h);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.noRepos });
});

// --- Model and prompt

test("a model tag picks one of Outrunner's; an unknown one is said, and doesn't stop it", async () => {
  const known = OUTRUNNER_MODELS[0].id;
  assert.deepEqual(pickModel(`use [model=${known}]`), { model: known });
  assert.deepEqual(pickModel("[model=nope]"), { unknown: "nope" });
  assert.deepEqual(pickModel(null, "no tag"), {});
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created({ session: { comment: { userId: "ana", body: "[model=nope]" } } }), h);
  assert.equal(h.log.started.length, 1);
  assert.equal(h.log.started[0].model, undefined);
  assert.ok(said(h.log).some((c) => c.type === "thought" && c.body.includes("nope")));
});

test("the first prompt has the issue as Linear tells it, and guidance not already in it", () => {
  const prompt = firstPrompt(created({ promptContext: "<issue>Body</issue>\n<guidance>Use tabs</guidance>", guidance: [{ body: "Use tabs" }, { body: "Write tests" }] }));
  assert.match(prompt, /Work on Linear issue ENG-1: Checkout breaks/);
  assert.match(prompt, /https:\/\/linear\.app\/a\/issue\/ENG-1/);
  assert.match(prompt, /Guidance from Linear:\n- Write tests/);
  assert.equal(prompt.match(/Use tabs/g)?.length, 1);
});

test("with no prompt context, the description stands in", () => {
  assert.match(firstPrompt(created({ promptContext: null })), /On Safari/);
});

// --- A session it already has

test("handed back to its session, that's restored and told, not a new one", async () => {
  const h = harness({}, { item: item({ workspaceId: "old", projectId: WEB.id, status: "done" }) });
  await send(created(), h);
  assert.equal(h.log.started.length, 0);
  assert.equal(h.log.sent[0].workspaceId, "old");
  assert.deepEqual(h.log.linked, [{ itemId: "item-1", workspaceId: "old", projectId: WEB.id }]);
  assert.equal(h.current()?.agentSessionId, AGENT);
  assert.equal(h.current()?.workspaceId, "old");
  assert.deepEqual(h.log.awaited, [AGENT]);
});

test("if it can't be restored, a new one starts and the item points at it", async () => {
  const h = harness({ send: async () => false }, { item: item({ workspaceId: "old", projectId: WEB.id }) });
  await send(created(), h);
  assert.equal(h.log.started.length, 1);
  assert.equal(h.log.started[0].projectId, WEB.id);
  assert.deepEqual(h.log.linked, [{ itemId: "item-1", workspaceId: "workspace-1", projectId: WEB.id }]);
});

test("someone with write steers the session as it is", async () => {
  const h = harness(
    { session: async (id) => ({ id, ownerId: "someone-else", projectId: WEB.id, status: "ready" }), level: async () => "write" },
    { item: item({ workspaceId: "old", projectId: WEB.id }) },
  );
  await send(created(), h);
  assert.equal(h.log.started.length, 0);
  assert.equal(h.log.sent[0].workspaceId, "old");
});

// --- States

test("an issue already past started isn't moved back", async () => {
  for (const stateType of ["started", "completed", "canceled", "duplicate"]) {
    const h = harness({ standing: async () => ({ teamId: TEAM, delegateId: "app-user", open: true, stateType }) }, { scope: scope({ defaultProjectId: WEB.id }) });
    await send(created(), h);
    assert.deepEqual(h.log.states, [], stateType);
  }
});

test("a team with the state map off, or no started state, isn't moved", async () => {
  for (const stateMap of [null, { started: null, inReview: "x", done: null, blocked: null }]) {
    const h = harness({}, { scope: scope({ defaultProjectId: WEB.id, stateMap }) });
    await send(created(), h);
    assert.deepEqual(h.log.states, []);
    assert.equal(h.log.started.length, 1);
  }
});

test("failing to move the issue doesn't stop the session", async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const h = harness(
      {
        setIssueState: async () => {
          throw new Error("down");
        },
      },
      { scope: scope({ defaultProjectId: WEB.id }) },
    );
    await send(created(), h);
    assert.deepEqual(h.log.awaited, [AGENT]);
  } finally {
    console.warn = warn;
  }
});

// --- Failure

test("a session that can't start says why, with a note on its item", async () => {
  const h = harness({ start: async () => ({ workspaceId: null, status: "refused", errorMessage: "Out of allowance." }) as ServerSessionResult }, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created(), h);
  assert.deepEqual(said(h.log).at(-1), { type: "error", body: "The session couldn't start: Out of allowance." });
  assert.match(h.log.notes[0].body, /Out of allowance/);
  assert.deepEqual(h.log.stoppedRows, [AGENT]);
  assert.deepEqual(h.log.awaited, []);
});

test("anything else going wrong after the answer is said, as nothing can redeliver it", async () => {
  const error = console.error;
  console.error = () => undefined;
  try {
    const h = harness({
      projects: async () => {
        throw new Error("database down");
      },
    });
    await send(created(), h);
    assert.equal(said(h.log).at(-1)?.type, "error");
  } finally {
    console.error = error;
  }
});

// --- Follow-ups and stop

const working = (over: Partial<AgentRow> = {}): AgentRow => ({
  agentSessionId: AGENT,
  installationId: INSTALL.id,
  orgId: ORG,
  issueId: ISSUE,
  itemId: "item-1",
  workspaceId: "workspace-1",
  ownerId: "ana-user",
  stage: "working",
  prompt: null,
  ruleStarted: false,
  ask: null,
  askedUser: null,
  ...over,
});

test("a follow-up from its owner goes to the session, with who said it", async () => {
  const h = harness({}, { row: working() });
  await send(prompted("also check Firefox"), h);
  assert.deepEqual(h.log.sent, [{ workspaceId: "workspace-1", text: "Ana (in Linear): also check Firefox" }]);
  assert.deepEqual(h.log.awaited, [AGENT]);
});

test("the body may come in content, or at the activity's top", async () => {
  const h = harness({}, { row: working() });
  await send({ ...created(), action: "prompted", agentActivity: { body: "top level", userId: "ana" } } as AgentPayload, h);
  assert.equal(h.log.sent[0].text, "top level");
});

test("a follow-up from someone who can't steer is told so, and goes nowhere", async () => {
  const h = harness({ session: async (id) => ({ id, ownerId: "someone-else", projectId: WEB.id, status: "ready" }) }, { row: working() });
  await send(prompted("hi"), h);
  assert.equal(h.log.sent.length, 0);
  assert.equal(said(h.log).at(-1)?.body, REPLIES.cantSteer);
});

test("a follow-up from someone unlinked is told to link", async () => {
  const h = harness({ linkedOwner: async () => null }, { row: working() });
  await send(prompted("hi"), h);
  assert.equal(h.log.sent.length, 0);
  assert.equal(said(h.log).at(-1)?.body, REPLIES.linkThenSay);
});

test("a session not answering says so", async () => {
  const h = harness({ send: async () => false }, { row: working() });
  await send(prompted("hi"), h);
  assert.deepEqual(said(h.log).at(-1), { type: "error", body: REPLIES.sendFailed });
});

test("a follow-up after linking starts over", async () => {
  const h = harness({}, { row: working({ stage: "awaiting_link", workspaceId: null }), scope: scope({ defaultProjectId: WEB.id }) });
  await send(prompted("linked now"), h);
  assert.equal(h.log.started.length, 1);
});

test("stop halts the turn at once, stops relaying, and answers", async () => {
  const h = harness({}, { row: working() });
  const result = await handleAgentEvent(INSTALL, prompted("stop", { signal: "stop" }), h.deps);
  assert.deepEqual(result, { handled: true });
  assert.deepEqual(h.log.stopped, ["workspace-1"]);
  assert.deepEqual(h.log.stoppedRows, [AGENT]);
  assert.deepEqual(said(h.log), [{ type: "response", body: REPLIES.stopped }]);
  assert.equal(h.log.deferred.length, 0);
});

test("a stop before there's a row is kept, and the delegation finds it", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }) });
  await handleAgentEvent(INSTALL, created(), h.deps);
  await handleAgentEvent(INSTALL, prompted("stop", { signal: "stop" }), h.deps);
  assert.equal(h.current()?.stage, "stopped");
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.stopped });
  await h.run();
  assert.deepEqual(h.log.started, []);
});

test("a stop while it's deciding: it doesn't start, and no slot goes", async () => {
  const h: ReturnType<typeof harness> = harness(
    {
      projects: async () => {
        await h.deps.saveRow(working({ stage: "stopped", workspaceId: null }), null);
        return [WEB, API];
      },
    },
    { scope: scope({ acceptRuleSessions: true, defaultProjectId: WEB.id }) },
  );
  await send(created({ session: { creatorId: null, creator: null } }), h);
  assert.deepEqual(h.log.started, []);
  assert.equal(h.log.slots, 0);
});

test("asked again after a stop, it may start", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null }) });
  await send(prompted("go on after all"), h);
  assert.equal(h.log.started.length, 1);
});

test("a stop with no issue to tie it to says nothing was running", async () => {
  const h = harness();
  await handleAgentEvent(INSTALL, { ...prompted("stop", { signal: "stop" }), agentSession: { id: AGENT } } as AgentPayload, h.deps);
  assert.deepEqual(said(h.log), [{ type: "response", body: REPLIES.nothingRunning }]);
});

test("the interrupt is bounded: a session that doesn't answer may still be running", async () => {
  const h = harness({ stop: () => new Promise(() => undefined) }, { row: working() });
  await handleAgentEvent(INSTALL, prompted("stop", { signal: "stop" }), h.deps);
  assert.equal(said(h.log).at(-1)?.type, "error");
  assert.match(said(h.log).at(-1)?.body ?? "", /may still be running/);
});

test("the hold goes before the watch: what's said during real work isn't told it's setting up", async () => {
  const held = new Map<string, string>();
  const order: string[] = [];
  const h = harness(
    {
      watchReply: async () => {
        order.push(`watching, held: ${held.size}`);
      },
    },
    { scope: scope({ defaultProjectId: WEB.id }), held },
  );
  await send(created(), h);
  assert.deepEqual(order, ["watching, held: 0"]);

  const session = { session: async () => ({ id: "w", ownerId: "ana-user", projectId: WEB.id, status: "ready" }) };
  const steered: string[] = [];
  const again = harness({ ...session, watchReply: async () => void steered.push(`held: ${held.size}`) }, { scope: scope(), item: item({ workspaceId: "w" }), held });
  await send(created({ session: { id: "agent-2" } }), again);
  assert.deepEqual(steered, ["held: 0"]);
  assert.equal(again.log.sent.length, 1);
  assert.notEqual(said(again.log).at(-1)?.body, REPLIES.busy, "a second delegation after start isn't told it's busy");
});

test("a watch that fails to run doesn't hold the issue", async () => {
  const held = new Map<string, string>();
  const error = console.error;
  console.error = () => undefined;
  try {
    const h = harness({ watchReply: async () => assert.fail("boom") }, { scope: scope({ defaultProjectId: WEB.id }), held });
    await send(created(), h);
    assert.equal(held.size, 0);
    assert.equal(said(h.log).filter((c) => c.type === "error").length, 0, "it did start: the tick carries on the watch");
  } finally {
    console.error = error;
  }
});

test("every session that isn't live counts as gone, not as someone else's", async () => {
  for (const status of ["archived", "archiving", "destroying", "destroyed"]) {
    const h = harness(
      { session: async () => ({ id: "w", ownerId: "ben-user", projectId: WEB.id, status }), level: async () => "read" },
      { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) },
    );
    await send(created(), h);
    assert.equal(h.log.started.length, 1, status);
  }
  const mine = harness({ session: async () => ({ id: "w", ownerId: "ana-user", projectId: WEB.id, status: "destroyed" }) }, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
  await send(created(), mine);
  assert.deepEqual(mine.log.sent, [], "there's nothing to send to");
  assert.equal(mine.log.started.length, 1);
});

test("resuming after a link: an issue closed since says so, and doesn't start", async () => {
  const row = working({ stage: "awaiting_link", workspaceId: null, ask: askOf(created()), openWhenAsked: true });
  const closed = harness({ standing: async () => ({ teamId: TEAM, delegateId: "app-user", open: false, stateType: "completed" }) }, { scope: scope({ defaultProjectId: WEB.id }), row });
  await resumeAfterLink(INSTALL, row, closed.deps);
  assert.deepEqual(closed.log.started, []);
  assert.deepEqual(said(closed.log), [{ type: "response", body: REPLIES.closedSince }]);
  assert.equal(closed.current()?.stage, "stopped");
  const gone = harness({ standing: async () => null }, { scope: scope({ defaultProjectId: WEB.id }), row });
  await resumeAfterLink(INSTALL, row, gone.deps);
  assert.deepEqual(gone.log.said, []);
});

test("what's kept of a delegation is capped: guidance too, and only its text", () => {
  const huge = "x".repeat(200_000);
  const ask = askOf(created({ guidance: Array.from({ length: 50 }, () => ({ body: huge, origin: { secret: "not kept" } })), session: { comment: { id: "c1", body: huge } }, issue: { description: huge }, promptContext: huge }));
  const guidance = ask.guidance as { body: string }[];
  assert.equal(guidance.length, 20);
  assert.ok((guidance[0]?.body.length ?? 0) <= 100_000);
  assert.deepEqual(Object.keys(guidance[0] ?? {}), ["body"]);
  assert.ok(String(ask.promptContext).length <= 100_000);
  assert.ok(String(ask.agentSession?.comment?.body).length <= 100_000);
  assert.equal(ask.agentSession?.comment?.id, "c1", "so an edit or delete can find it");
});

test("the session's branch and first prompt carry the issue's key", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created(), h);
  assert.deepEqual(h.log.started[0]?.issue, { source: "linear", key: "ENG-1" }, "named for it where the session starts, against GitHub too");
  assert.match(h.log.started[0]?.prompt ?? "", /Keep ENG-1 in any branch you name, e\.g\. `fix\/eng-1-what-it-does`/);
  const keyless = harness({}, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created({ issue: { identifier: undefined } }), keyless);
  assert.equal(keyless.log.started[0]?.issue, undefined, "a generated one then");
  assert.doesNotMatch(keyless.log.started[0]?.prompt ?? "", /Keep/);
});

// --- Review findings on Phase 2

test("a stop that failed says so, with the link, rather than that it stopped", async () => {
  const h = harness({ stop: async () => false }, { row: working() });
  await handleAgentEvent(INSTALL, prompted("stop", { signal: "stop" }), h.deps);
  const last = said(h.log).at(-1);
  assert.equal(last?.type, "error");
  assert.match(last?.body ?? "", /couldn't stop.*may still be running.*workspaces\/workspace-1/);
  assert.deepEqual(h.log.stoppedRows, [AGENT], "nothing more is relayed either way");
});

test("stopped during setup: the row stays stopped, it isn't linked up, and the session is interrupted once up", async () => {
  const h: ReturnType<typeof harness> = harness(
    {
      start: async (begun) => {
        h.log.started.push(begun);
        await h.deps.stopRow(AGENT);
        await begun.onCreated?.("workspace-1");
        return { workspaceId: "workspace-1", status: "ready" } as ServerSessionResult;
      },
    },
    { scope: scope({ defaultProjectId: WEB.id }) },
  );
  await send(created(), h);
  assert.equal(h.current()?.stage, "stopped", "not upserted back to working");
  assert.equal(h.current()?.workspaceId, "workspace-1", "it knows its session");
  assert.deepEqual(h.log.watches, [], "no watch");
  assert.deepEqual(h.log.states, [], "the issue isn't moved");
  assert.deepEqual(h.log.stopped, ["workspace-1"], "interrupted");
  assert.deepEqual(h.log.awaited, []);
});

test("a retry while the first delivery is still acting does nothing more", async () => {
  const held = new Map([[ISSUE, AGENT]]);
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }), held });
  await send(created(), h);
  assert.deepEqual(h.log.started, []);
  assert.equal(said(h.log).filter((c) => c.type === "response").length, 0);
  assert.deepEqual(h.log.released, [], "not its to let go");
});

test("a retry after the first has saved where it stands says nothing, and starts nothing", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }), row: working() });
  await send(created(), h);
  assert.deepEqual(h.log.started, []);
  assert.deepEqual(h.log.said, []);
});

test("two deliveries at once: one session", async () => {
  const held = new Map<string, string>();
  const a = harness({}, { scope: scope({ defaultProjectId: WEB.id }), held });
  const b = harness({}, { scope: scope({ defaultProjectId: WEB.id }), held });
  await handleAgentEvent(INSTALL, created(), a.deps);
  await handleAgentEvent(INSTALL, created(), b.deps);
  // The first is mid-start as the second runs.
  held.set(ISSUE, AGENT);
  await b.run();
  assert.deepEqual(b.log.started, []);
  held.delete(ISSUE);
  await a.run();
  assert.equal(a.log.started.length, 1);
});

test("a delegation and an @mention close together: the second hears why, and starts nothing", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }), held: new Map([[ISSUE, "another-agent-session"]]) });
  await send(created(), h);
  assert.deepEqual(h.log.started, []);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.busy });
});

test("a follow-up before its session is made hears why, rather than starting another", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }), row: working({ workspaceId: null }), held: new Map([[ISSUE, AGENT]]) });
  await send(prompted("and this"), h);
  assert.deepEqual(h.log.started, []);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.busy });
});

test("the hold goes when the work's done, or if it fails", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created(), h);
  assert.deepEqual(h.log.released, [AGENT]);
  const error = console.error;
  console.error = () => undefined;
  try {
    const failing = harness({ projects: async () => assert.fail("boom") });
    await send(created(), failing);
    assert.deepEqual(failing.log.released, [AGENT]);
  } finally {
    console.error = error;
  }
});

const ruleOn = () => scope({ acceptRuleSessions: true, defaultProjectId: WEB.id });
const fromRule = (over: Record<string, unknown> = {}) => created({ session: { creatorId: null, creator: null, ...over } });

test("a slot goes only as a rule's session really starts", async () => {
  const noPerson = harness({ creator: async () => null }, { scope: ruleOn() });
  await send(fromRule(), noPerson);
  assert.equal(noPerson.log.slots, 0, "no one to run it as");

  const unlinked = harness({ linkedOwner: async () => null }, { scope: ruleOn() });
  await send(fromRule(), unlinked);
  assert.equal(unlinked.log.slots, 0, "asked to link");
  await send(prompted("still no"), unlinked);
  assert.equal(unlinked.log.slots, 0, "nor by asking again");

  const askingRepo = harness({}, { scope: scope({ acceptRuleSessions: true }) });
  await send(fromRule(), askingRepo);
  assert.equal(askingRepo.log.slots, 0, "asked which repo");
  assert.equal(askingRepo.current()?.ruleStarted, true);
  await send(prompted("acme/web"), askingRepo);
  assert.equal(askingRepo.log.slots, 1, "taken once it starts");
  assert.equal(askingRepo.log.started.length, 1);

  const steering = harness({}, { scope: ruleOn(), item: item({ workspaceId: "workspace-1" }) });
  await send(fromRule(), steering);
  assert.equal(steering.log.slots, 1, "work a rule started counts, on what its runner owns");
  assert.equal(steering.log.sent.length, 1);
  assert.equal(steering.log.started.length, 0);

  const someoneElses = harness({ session: async () => ({ id: "workspace-1", ownerId: "ben-user", projectId: WEB.id, status: "ready" }), level: async () => "write" }, { scope: ruleOn(), item: item({ workspaceId: "workspace-1" }) });
  await send(fromRule(), someoneElses);
  assert.equal(someoneElses.log.sent.length, 0, "it may be on their own keys");
  assert.equal(someoneElses.log.slots, 0);
  assert.deepEqual(said(someoneElses.log).at(-1), { type: "response", body: REPLIES.cantSteer });

  const steerCapped = harness({ claimRuleSession: async () => false }, { scope: ruleOn(), item: item({ workspaceId: "workspace-1" }) });
  await send(fromRule(), steerCapped);
  assert.equal(steerCapped.log.sent.length, 0);
  assert.deepEqual(said(steerCapped.log).at(-1), { type: "response", body: capReply(20) });

  const starts = harness({}, { scope: ruleOn() });
  await send(fromRule(), starts);
  assert.equal(starts.log.slots, 1);

  const capped = harness({ claimRuleSession: async () => false }, { scope: ruleOn() });
  await send(fromRule(), capped);
  assert.deepEqual(capped.log.started, []);
  assert.deepEqual(said(capped.log).at(-1), { type: "response", body: capReply(20) });
});

test("asked to link: the task is kept, its tag included, and linking carries it on", async () => {
  let linked = false;
  const h = harness({ linkedOwner: async (_i, id) => (linked && id === "ana" ? "ana-user" : null) }, { scope: scope() });
  const asked = created({ session: { comment: { userId: "ana", body: "Please fix [repo=acme/api]" } } });
  await send(asked, h);
  const row = h.current() as AgentRow;
  assert.equal(row.stage, "awaiting_link");
  assert.equal(row.askedUser, "ana");
  assert.match(row.prompt ?? "", /Checkout breaks/);
  linked = true;
  await resumeAfterLink(INSTALL, row, h.deps);
  assert.equal(h.log.started[0]?.projectId, API.id, "from the comment's tag");
  assert.match(h.log.started[0]?.prompt ?? "", /Checkout breaks/);
});

test("a reply while asked to link needn't repeat the task", async () => {
  let linked = false;
  const h = harness({ linkedOwner: async (_i, id) => (linked && id === "ana" ? "ana-user" : null) }, { scope: scope() });
  await send(created({ session: { comment: { userId: "ana", body: "[repo=acme/api]" } } }), h);
  linked = true;
  const bare = { action: "prompted", agentSession: { id: AGENT, issueId: ISSUE }, agentActivity: { content: { body: "done" }, userId: "ana" } } as AgentPayload;
  await send(bare, h);
  assert.equal(h.log.started[0]?.projectId, API.id);
  assert.match(h.log.started[0]?.prompt ?? "", /Checkout breaks/);
});

test("which repo: only whoever it runs as may answer", async () => {
  const h = harness(
    { linkedOwner: async (_i, id) => (id === "ana" ? "ana-user" : id === "ben" ? "ben-user" : null) },
    { row: working({ stage: "awaiting_repo", workspaceId: null }), scope: scope() },
  );
  await send(prompted("acme/web", { userId: "ben" }), h);
  assert.deepEqual(h.log.started, []);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.notYours });
  await send(prompted("acme/web", { userId: "zed" }), h);
  assert.deepEqual(h.log.started, [], "nor someone unlinked");
  await send(prompted("acme/web"), h);
  assert.equal(h.log.started.length, 1);
});

test("a rule doesn't undo a decision made here, and spends nothing; a person may", async () => {
  for (const status of ["declined", "duplicate"] as const) {
    const h = harness({}, { scope: ruleOn(), item: item({ status }) });
    await send(fromRule(), h);
    assert.deepEqual(h.log.started, [], status);
    assert.equal(h.log.slots, 0, status);
    assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.ruleDeclined });
  }
  const person = harness({}, { scope: scope({ defaultProjectId: WEB.id }), item: item({ status: "declined" }) });
  await send(created(), person);
  assert.equal(person.log.started.length, 1);
});

test("someone who can't steer a live session is told so, and it isn't replaced", async () => {
  const live = { session: async () => ({ id: "w", ownerId: "ben-user", projectId: WEB.id, status: "ready" }), level: async () => "read" as const };
  const h = harness(live, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
  await send(created(), h);
  assert.deepEqual(h.log.started, []);
  assert.deepEqual(h.log.linked, []);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.cantSteer });

  const gone = harness({ session: async () => null }, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
  await send(created(), gone);
  assert.equal(gone.log.started.length, 1, "a session that's gone is replaced");

  const archived = harness({ ...live, session: async () => ({ id: "w", ownerId: "ben-user", projectId: WEB.id, status: "archived" }) }, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
  await send(created(), archived);
  assert.equal(archived.log.started.length, 1, "so is an archived one");

  const unreachable = harness({ send: async () => false }, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
  await send(created(), unreachable);
  assert.equal(unreachable.log.started.length, 1, "and one that can't be reached");
});

test("an empty reply isn't sent to the session", async () => {
  const h = harness({}, { row: working() });
  await send(prompted("  "), h);
  assert.deepEqual(h.log.sent, []);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.empty });
});

test("a failed follow-up doesn't claim something didn't start", async () => {
  const error = console.error;
  console.error = () => undefined;
  try {
    const h = harness({ session: async () => assert.fail("boom") }, { row: working() });
    await send(prompted("more"), h);
    assert.match(said(h.log).at(-1)?.body ?? "", /didn't reach the session/);
  } finally {
    console.error = error;
  }
});

test("a turn sent is watched from before the send, by the conversation's own clock", async () => {
  const h = harness({}, { row: working() });
  await send(prompted("more"), h);
  assert.deepEqual(h.log.watches, [{ sentAt: 5000, baselineActivity: 1000 }]);
  assert.deepEqual(h.log.awaited, [AGENT]);
});

test("an event with no agent session, or an action we don't know, does nothing", async () => {
  const h = harness();
  assert.equal((await handleAgentEvent(INSTALL, { action: "created" }, h.deps)).handled, false);
  assert.equal((await handleAgentEvent(INSTALL, { ...created(), action: "other" }, h.deps)).handled, false);
  assert.deepEqual(h.log.said, []);
});

// --- What real Linear sent, Nov 8: its editor escapes what's typed.

test("a tag typed in Linear arrives escaped, and still counts", () => {
  const readable = [WEB, API, { id: "33333333-3333-4333-8333-333333333333", fullName: "acme/web_x.y" }];
  const asked = (comment: string | null, guidance: string[] = []) => pickRepo({ comment, itemProjectId: null, defaultProjectId: null, guidance, readable });
  assert.equal(asked("please use \\[repo=acme/api\\] thanks")?.id, API.id);
  assert.equal(asked("\\[repo=acme/web\\_x.y\\]")?.fullName, "acme/web_x.y");
  assert.equal(asked(null, ["Team guidance. Default \\[repo=acme/api\\]."])?.id, API.id);
  assert.deepEqual(pickModel("use \\[model=nope\\]"), { unknown: "nope" });
  assert.equal(repoFromReply("\\[repo=acme/api\\]", readable)?.id, API.id);
  assert.equal(repoFromReply("acme/web\\_x.y", readable)?.fullName, "acme/web_x.y");
});

test("a person's words reach the session without Linear's escapes", async () => {
  const h = harness({}, { row: working() });
  await send(prompted("look at \\[this\\] please"), h);
  assert.equal(h.log.sent[0]?.text, "Ana (in Linear): look at [this] please");
});

test("the team's guidance counts before the workspace's, however Linear orders them", () => {
  const guidance = [
    { origin: { type: "Organization" }, body: "Workspace [repo=acme/web]." },
    { origin: { type: "Team", team: { id: TEAM } }, body: "Team \\[repo=acme/api\\]." },
  ];
  const kept = askOf(created({ guidance })).guidance as { body: string }[];
  assert.deepEqual(kept.map((rule) => rule.body), ["Team \\[repo=acme/api\\].", "Workspace [repo=acme/web]."]);
  const h = harness({}, { scope: scope() });
  return send(created({ guidance }), h).then(() => assert.equal(h.log.started[0]?.projectId, API.id));
});

const again = { issueId: ISSUE, actorId: "ana", actorName: "Ana", issue: { id: ISSUE, identifier: "ENG-1", teamId: TEAM, title: "Checkout breaks", description: "On Safari", url: "https://linear.app/a/issue/ENG-1" } };

test("delegated again: Linear sends no agent event, so the stopped row picks it up on its session", async () => {
  const session = { session: async () => ({ id: "workspace-1", ownerId: "ana-user", projectId: WEB.id, status: "ready" }) };
  const h = harness(session, { scope: scope(), item: item({ workspaceId: "workspace-1" }), row: working({ stage: "stopped", ask: askOf(created()) }) });
  await handleRedelegated(INSTALL, again, h.deps);
  assert.equal(h.log.sent.length, 1);
  assert.equal(h.current()?.stage, "working");
  assert.equal(h.current()?.agentSessionId, AGENT);
  assert.deepEqual(said(h.log)[0], { type: "thought", body: "Looking at this issue." });
  assert.deepEqual(h.log.awaited, [AGENT]);
});

test("a first delegation isn't taken for one again: its row isn't stopped, or isn't there", async () => {
  for (const row of [null, working(), working({ stage: "awaiting_repo" })]) {
    const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }), row });
    await handleRedelegated(INSTALL, again, h.deps);
    assert.deepEqual(h.log.said, []);
    assert.deepEqual(h.log.started, []);
  }
});

test("delegated again by a rule is a rule's, and starts on the issue as the event told it", async () => {
  const off = harness({}, { scope: scope({ defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null, ask: null }) });
  await handleRedelegated(INSTALL, { ...again, actorId: null }, off.deps);
  assert.deepEqual(said(off.log).at(-1), { type: "response", body: REPLIES.rulesOff });
  const on = harness({}, { scope: scope({ defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null, ask: null }) });
  await handleRedelegated(INSTALL, again, on.deps);
  assert.equal(on.log.started[0]?.userId, "ana-user");
  assert.equal(on.log.started[0]?.title, "Checkout breaks");
  assert.deepEqual(on.log.started[0]?.issue, { source: "linear", key: "ENG-1" });
});

test("a delegation by an app has no creatorId at all, and takes the rule's path", async () => {
  // As delivered: `creatorId` and `creator` absent, and the activity's userId is the app's.
  const h = harness({}, { scope: scope() });
  const session = Object.fromEntries(Object.entries(created().agentSession as object).filter(([key]) => key !== "creatorId" && key !== "creator"));
  await send({ ...created(), agentSession: session } as AgentPayload, h);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.rulesOff });
});

test("code is left as written, and a tag quoted in code isn't one being used", () => {
  assert.equal(withoutEscapes("match \\[this\\] with `a\\.b` too"), "match [this] with `a\\.b` too");
  assert.equal(withoutEscapes("before \\_x\n```\nre = /a\\.b\\[c/\n```\nafter \\_y"), "before _x\n```\nre = /a\\.b\\[c/\n```\nafter _y");
  assert.equal(withoutEscapes("```\nnever closed \\."), "```\nnever closed \\.");
  assert.equal(withoutEscapes("an escaped \\` isn't code \\."), "an escaped ` isn't code .");
  const asked = (comment: string) => pickRepo({ comment, itemProjectId: null, defaultProjectId: null, guidance: [], readable: [WEB, API] });
  assert.equal(asked("run with `[repo=acme/api]` as the tag"), null);
  assert.equal(asked("```\n[repo=acme/api]\n```"), null);
  assert.equal(asked("`[repo=acme/web]` is how, but \\[repo=acme/api\\]")?.id, API.id);
  assert.deepEqual(pickModel("the `[model=nope]` tag"), {});
});

test("a person's code reaches the session untouched", async () => {
  const h = harness({}, { row: working() });
  await send(prompted("use `a\\.b` not \\[that\\]"), h);
  assert.equal(h.log.sent[0]?.text, "Ana (in Linear): use `a\\.b` not [that]");
});

const racing = (over: Partial<AgentDeps>, setup: Parameters<typeof harness>[1]) => harness(over, { scope: scope({ defaultProjectId: WEB.id }), ...setup });

test("a mention stopped, then delegated (real order: no created, only the issue's change): the same session carries on", async () => {
  const h = racing({}, { row: working({ stage: "stopped", workspaceId: null, ask: askOf(created()) }) });
  await handleRedelegated(INSTALL, again, h.deps);
  assert.equal(h.log.started.length, 1);
  assert.equal(h.current()?.agentSessionId, AGENT);
});

test("the issue's change after created finished: its row is the newest, and isn't stopped", async () => {
  const h = racing({}, { row: working({ agentSessionId: "agent-new", stage: "working", workspaceId: "w" }) });
  await handleRedelegated(INSTALL, again, h.deps);
  assert.deepEqual(h.log.said, []);
  assert.deepEqual(h.log.started, []);
});

test("created wins while the issue's change waits for the hold: it looks again, and leaves it", async () => {
  // The first look sees the old stopped row; by the time it has the hold, created has been and gone.
  const stopped = working({ stage: "stopped", workspaceId: null });
  const looks = [stopped, working({ agentSessionId: "agent-new", stage: "working", workspaceId: "w" })];
  const h = racing({ latestRow: async () => looks.shift() ?? null }, { row: stopped });
  await handleRedelegated(INSTALL, again, h.deps);
  assert.deepEqual(h.log.said, []);
  assert.deepEqual(h.log.started, []);
});

test("created after the issue's change already acted is told it's busy, or steers: never a second start", async () => {
  const held = new Map<string, string>();
  const first = racing({ start: async () => {
    // created arrives for another session during the start.
    const second = racing({}, { held, item: item() });
    await send(created({ session: { id: "agent-new" } }), second);
    assert.deepEqual(second.log.started, []);
    assert.deepEqual(said(second.log).at(-1), { type: "response", body: REPLIES.busy });
    return { workspaceId: "w", status: "ready" } as ServerSessionResult;
  } }, { held, row: working({ stage: "stopped", workspaceId: null, ask: askOf(created()) }) });
  await handleRedelegated(INSTALL, again, first.deps);
  assert.equal(held.size, 0);
});

test("delegated after a mention that's over (real: same session, no created): it's told, not lost", async () => {
  const mention = askOf(created({ session: { sourceMetadata: { type: "comment", agentSessionMetadata: { sourceCommentId: "c1" } } } }));
  assert.deepEqual(mention.agentSession?.sourceMetadata, { type: "comment" }, "kept, and only what's needed");
  const session = { session: async () => ({ id: "workspace-1", ownerId: "ana-user", projectId: WEB.id, status: "ready" }) };
  const h = harness(session, { scope: scope(), item: item({ workspaceId: "workspace-1" }), row: working({ ask: mention, fromMention: true }) });
  await handleRedelegated(INSTALL, again, h.deps);
  assert.equal(h.log.sent.length, 1);
  assert.equal(h.current()?.fromMention, false, "once: it's a delegated one from here on");
  const before = h.log.sent.length;
  await handleRedelegated(INSTALL, again, h.deps);
  assert.equal(h.log.sent.length, before);
});

test("a first delegation's own issue change finds its row isn't a mention's, and leaves it", async () => {
  const h = harness({}, { scope: scope(), row: working({ ask: askOf(created()) }) });
  await handleRedelegated(INSTALL, again, h.deps);
  assert.deepEqual(h.log.sent, []);
  assert.deepEqual(h.log.said, []);
});

test("delegated while a mention's question waits leaves the question to be answered", async () => {
  const mention = askOf(created({ session: { sourceMetadata: { type: "comment" } } }));
  const h = harness({}, { scope: scope(), row: working({ stage: "awaiting_repo", workspaceId: null, ask: mention }) });
  await handleRedelegated(INSTALL, again, h.deps);
  assert.deepEqual(h.log.said, []);
});

// --- A delegation Linear only tells of on the issue

const AT = Date.parse("2026-11-08T14:08:44.144Z");
const delegatedAt = { createdAt: new Date(AT).toISOString() };

test("a mention older than the text kept: its row still says so, and the delegation is told", async () => {
  const session = { session: async () => ({ id: "workspace-1", ownerId: "ana-user", projectId: WEB.id, status: "ready" }) };
  const h = harness(session, { scope: scope(), item: item({ workspaceId: "workspace-1" }), row: working({ ask: null, prompt: null, fromMention: true, sessionCreatedAt: AT }) });
  await handleRedelegated(INSTALL, { ...again, at: AT + 8 * 24 * 60 * 60_000 }, h.deps);
  assert.equal(h.log.sent.length, 1);
  assert.match(h.log.sent[0]?.text ?? "", /Checkout breaks/, "from the event, as the kept text is gone");
});

const refusals: [string, Partial<AgentDeps>, Parameters<typeof harness>[1], string][] = [
  ["not connected", {}, { scope: null }, REPLIES.notConnected],
  ["not a member", { triageActor: async () => null }, { scope: scope() }, REPLIES.notMember],
  ["no repositories", { triageActor: async (u) => actor(u, []) }, { scope: scope() }, REPLIES.noRepos],
];

test("a refusal leaves a row, keeping what was asked, and says so once", async () => {
  for (const [name, over, setup, reply] of refusals) {
    const h = harness(over, setup);
    await send(created({ session: delegatedAt }), h);
    assert.equal(h.current()?.stage, "stopped", name);
    assert.ok(h.current()?.ask, name);
    assert.equal(h.current()?.sessionCreatedAt, AT, name);
    const replies = () => said(h.log).filter((c) => c.type === "response");
    assert.deepEqual(replies().map((c) => c.body), [reply], name);
    // Linear's real order: the issue's own change comes right after created.
    await handleRedelegated(INSTALL, { ...again, at: AT + 50 }, h.deps);
    assert.equal(replies().length, 1, `${name}: refused once, not twice`);
    assert.deepEqual(h.log.started, [], name);
  }
});

test("every refusal on a rule's path keeps it a rule's", async () => {
  const off = harness({}, { scope: scope() });
  await send(created({ session: { creatorId: null, creator: null, ...delegatedAt } }), off);
  assert.equal(off.current()?.stage, "stopped");
  assert.equal(off.current()?.ruleStarted, true);
  const capped = harness({ claimRuleSession: async () => false }, { scope: scope({ acceptRuleSessions: true, defaultProjectId: WEB.id }) });
  await send(created({ session: { creatorId: null, creator: null, ...delegatedAt } }), capped);
  assert.equal(capped.current()?.stage, "stopped");
  const declined = harness({}, { scope: scope({ acceptRuleSessions: true }), item: item({ status: "declined" }) });
  await send(created({ session: { creatorId: null, creator: null, ...delegatedAt } }), declined);
  assert.equal(declined.current()?.stage, "stopped");
  const steer = harness({ session: async () => ({ id: "w", ownerId: "ben-user", projectId: WEB.id, status: "ready" }), level: async () => "read" }, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
  await send(created({ session: delegatedAt }), steer);
  assert.equal(steer.current()?.stage, "stopped", "can't steer");
});

test("refused, fixed, delegated again: it starts, on the same agent session", async () => {
  let connected = false;
  const h = harness({ scopeForTeam: async () => (connected ? scope({ defaultProjectId: WEB.id }) : null) });
  await send(created({ session: delegatedAt }), h);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.notConnected });
  connected = true;
  await handleRedelegated(INSTALL, { ...again, at: AT + 120_000 }, h.deps);
  assert.equal(h.log.started.length, 1);
  assert.equal(h.log.started[0]?.userId, "ana-user");
  assert.equal(h.current()?.agentSessionId, AGENT);
  assert.equal(h.current()?.stage, "working");
  assert.equal(h.current()?.sessionCreatedAt, AT, "still when Linear made it");
});

test("a stop within seconds of created isn't undone by that delegation's own issue change", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null, sessionCreatedAt: AT }) });
  await handleRedelegated(INSTALL, { ...again, at: AT + 80 }, h.deps);
  assert.deepEqual(h.log.started, []);
  await handleRedelegated(INSTALL, { ...again, at: AT + 7000 }, h.deps);
  assert.equal(h.log.started.length, 1, "seven seconds is a person, or a script: seen for real");
});

test("with no clock to go on, a stopped row counts: a lost delegation is worse than a second reply", async () => {
  const h = harness({}, { scope: scope({ defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null }) });
  await handleRedelegated(INSTALL, again, h.deps);
  assert.equal(h.log.started.length, 1);
});

// --- Starting again by a reply, and rows in use

const linkedAnaAndBen = { linkedOwner: async (_i: string, id: string) => (id === "ana" ? "ana-user" : id === "ben" ? "ben-user" : null) };
const asAna = () => askOf(created({ session: delegatedAt }));

test("someone else's reply starts nothing on the asker's account, on any way in", async () => {
  const rows: [string, AgentRow][] = [
    ["refused", working({ stage: "stopped", workspaceId: null, ask: asAna() })],
    ["asked to link", working({ stage: "awaiting_link", workspaceId: null, ask: asAna(), askedUser: "ana" })],
    ["a start that died", working({ workspaceId: null, ask: asAna() })],
    ["its session gone", working({ workspaceId: "gone", ask: asAna() })],
  ];
  for (const [name, row] of rows) {
    const h = harness({ ...linkedAnaAndBen, session: async () => null }, { scope: scope({ defaultProjectId: WEB.id }), row });
    await send(prompted("run it", { userId: "ben" }), h);
    assert.deepEqual(h.log.started, [], name);
    assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.notYoursToRestart }, name);
    assert.deepEqual(h.current(), row, `${name}: its row is as it was`);
  }
});

test("someone unlinked is told to link, and starts nothing", async () => {
  const h = harness(linkedAnaAndBen, { scope: scope({ defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null, ask: asAna() }) });
  await send(prompted("run it", { userId: "zed" }), h);
  assert.deepEqual(h.log.started, []);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.linkThenSay });
  const nobody = harness(linkedAnaAndBen, { scope: scope({ defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null, ask: asAna() }) });
  await send(prompted("run it", { userId: undefined }), nobody);
  assert.deepEqual(nobody.log.started, []);
});

test("whoever it runs as can start it again, on each way in", async () => {
  for (const row of [
    working({ stage: "stopped", workspaceId: null, ask: asAna() }),
    working({ stage: "awaiting_link", workspaceId: null, ask: asAna(), askedUser: "ana" }),
    working({ workspaceId: null, ask: asAna() }),
    working({ workspaceId: "gone", ask: asAna() }),
  ]) {
    const h = harness({ ...linkedAnaAndBen, session: async () => null }, { scope: scope({ defaultProjectId: WEB.id }), row });
    await send(prompted("run it"), h);
    assert.equal(h.log.started[0]?.userId, "ana-user", row.stage);
  }
});

test("a rule's row: only the issue's creator can start it, and it's still a rule's", async () => {
  const ruleAsk = askOf(created({ session: { creatorId: null, creator: null } }));
  const row = working({ stage: "stopped", workspaceId: null, ask: ruleAsk, ruleStarted: true });
  const on = { scope: scope({ acceptRuleSessions: true, defaultProjectId: WEB.id }), row };
  const other = harness(linkedAnaAndBen, on);
  await send(prompted("go", { userId: "ben" }), other);
  assert.deepEqual(other.log.started, []);
  assert.equal(other.log.slots, 0);
  const creator = harness(linkedAnaAndBen, on);
  await send(prompted("go"), creator);
  assert.equal(creator.log.started[0]?.userId, "ana-user");
  assert.equal(creator.log.slots, 1, "the cap still applies");
  const off = harness(linkedAnaAndBen, { scope: scope({ defaultProjectId: WEB.id }), row });
  await send(prompted("go"), off);
  assert.deepEqual(said(off.log).at(-1), { type: "response", body: REPLIES.rulesOff });
});

test("what they said goes with it: in the prompt, and its tags count first", async () => {
  const h = harness({ session: async () => null }, { scope: scope({ defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null, ask: asAna() }) });
  await send(prompted("please use \\[repo=acme/api\\] and \\[model=nope\\], and fix the tests"), h);
  assert.equal(h.log.started[0]?.projectId, API.id);
  assert.match(h.log.started[0]?.prompt ?? "", /They added, in Linear: please use \[repo=acme\/api\] .*fix the tests/);
  assert.match(h.log.started[0]?.prompt ?? "", /Checkout breaks/, "with what was first asked");
  assert.ok(said(h.log).some((c) => /no model called nope/.test(c.body)));
  assert.match(String(h.current()?.ask?.said), /fix the tests/, "kept, in case it has to ask something first");
});

test("asked to link and replying: it's kept for when they do", async () => {
  const h = harness({ linkedOwner: async () => null }, { scope: scope(), row: working({ stage: "awaiting_link", workspaceId: null, ask: asAna(), askedUser: "ana" }) });
  await send(prompted("use [repo=acme/api]"), h);
  assert.match(h.current()?.prompt ?? "", /They added, in Linear: use \[repo=acme\/api\]/);
  assert.match(String(h.current()?.ask?.said), /repo=acme\/api/);
});

const inUse = () => working({ workspaceId: "workspace-1", ownerId: "ana-user", ask: asAna(), fromMention: true, sessionCreatedAt: AT });
const anaSession = { session: async () => ({ id: "workspace-1", ownerId: "ana-user", projectId: WEB.id, status: "ready" }), level: async () => "read" as const };

test("someone who can't steer delegating leaves a working row as it was, and its relay carries on", async () => {
  const h = harness({ ...linkedAnaAndBen, ...anaSession }, { scope: scope(), row: inUse() });
  await handleRedelegated(INSTALL, { ...again, actorId: "ben", actorName: "Ben", at: AT + 60_000 }, h.deps);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.cantSteer });
  assert.deepEqual(h.current(), inUse(), "stage, session, owner, what was asked");
  assert.deepEqual(h.rows(), [], "nothing was written over it");
  assert.deepEqual(h.log.stopped, []);
  assert.deepEqual(h.log.started, []);
});

test("someone who can't steer delegating a stopped one: the row still knows its session", async () => {
  const stopped = () => working({ stage: "stopped", workspaceId: "workspace-1", ownerId: "ana-user", ask: asAna(), sessionCreatedAt: AT });
  const h = harness({ ...linkedAnaAndBen, ...anaSession }, { scope: scope(), row: stopped() });
  await handleRedelegated(INSTALL, { ...again, actorId: "ben", actorName: "Ben", at: AT + 60_000 }, h.deps);
  assert.deepEqual(h.current(), stopped());
});

test("a refusal with a row keeps it; only one with none writes", async () => {
  const notMember = { ...linkedAnaAndBen, ...anaSession, triageActor: async () => null };
  const h = harness(notMember, { scope: scope(), row: inUse() });
  await handleRedelegated(INSTALL, { ...again, at: AT + 60_000 }, h.deps);
  assert.deepEqual(h.current(), inUse());
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.notMember });
});

test("someone unlinked delegating doesn't take over a session: they're told to ask again after linking", async () => {
  const h = harness(linkedAnaAndBen, { scope: scope(), row: inUse() });
  await handleRedelegated(INSTALL, { ...again, actorId: "zed", actorName: "Zed", at: AT + 60_000 }, h.deps);
  assert.deepEqual(h.current(), inUse());
  assert.equal(said(h.log).at(-1)?.body, REPLIES.linkFirst);
});

test("steered by someone with write: what was first asked stays, so a restart runs as the asker", async () => {
  const h = harness({ ...linkedAnaAndBen, ...anaSession, level: async () => "write" }, { scope: scope(), row: inUse() });
  await handleRedelegated(INSTALL, { ...again, actorId: "ben", actorName: "Ben", at: AT + 60_000 }, h.deps);
  assert.equal(h.log.sent.length, 1);
  assert.equal(h.current()?.ask?.agentSession?.creatorId, "ana");
  assert.equal(h.current()?.ownerId, "ana-user");
});

test("a row knows a session its item doesn't: it's told, rather than a second one starting", async () => {
  const h = harness({ ...anaSession, item: async () => null }, { scope: scope({ defaultProjectId: WEB.id }), row: inUse() });
  await handleRedelegated(INSTALL, { ...again, at: AT + 60_000 }, h.deps);
  assert.equal(h.log.sent.length, 1);
  assert.deepEqual(h.log.started, []);
});

test("a tag counts from their own words, and never the description: anyone who can edit it can edit that", async () => {
  const run = async (session: Record<string, unknown>, issue: Record<string, unknown>, creator = { id: "ana", name: "Ana" }) => {
    const h = harness({ creator: async () => creator }, { scope: scope({ defaultProjectId: WEB.id }) });
    await send(created({ session, issue }), h);
    return h.log.started[0]?.projectId;
  };
  assert.equal(await run({ comment: { userId: "ana", body: "[repo=acme/api]" } }, {}), API.id, "their comment");
  assert.equal(await run({ comment: { userId: "zed", body: "[repo=acme/api]" } }, {}), WEB.id, "someone else's");
  assert.equal(await run({ comment: { body: "[repo=acme/api]" } }, {}), WEB.id, "no one's");
  assert.equal(await run({}, { description: "[repo=acme/api]" }), WEB.id, "even of an issue they made");
  assert.equal(await run({}, { description: "[repo=acme/api]" }, { id: "zed", name: "Zed" }), WEB.id, "or someone else did");
  const guided = harness({ creator: async () => ({ id: "zed", name: "Zed" }) }, { scope: scope() });
  await send(created({ guidance: [{ body: "[repo=acme/api]" }] }), guided);
  assert.equal(guided.log.started[0]?.projectId, API.id, "guidance is an admin's");
  const model = harness({}, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created({ issue: { description: `[model=${OUTRUNNER_MODELS[0].id}]` } }), model);
  assert.equal(model.log.started[0]?.model, undefined, "nor a model on their allowance");
});

test("told something while a Stop is pressed: the Stop stands, and it's interrupted", async () => {
  // Reply to a working one.
  const h = harness({ send: async () => { await h.deps.stopRow(AGENT); return true; } }, { row: working() });
  await send(prompted("and this"), h);
  assert.equal(h.current()?.stage, "stopped");
  assert.deepEqual(h.log.stopped, [h.current()?.workspaceId]);
  assert.deepEqual(h.log.watches, []);
  // Starting a stopped one again.
  const again2 = harness({ send: async () => { await again2.deps.stopRow(AGENT); return true; } }, { row: working({ stage: "stopped" }) });
  await send(prompted("and this"), again2);
  assert.equal(again2.current()?.stage, "stopped");
  assert.equal(again2.log.stopped.length, 1);
  assert.deepEqual(again2.log.watches, []);
  // Steering what an item has: no row yet, and a Stop writes one.
  const steer = harness({ send: async () => { await steer.deps.saveRow(working({ stage: "stopped" }), null); return true; } }, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
  await send(created(), steer);
  assert.equal(steer.current()?.stage, "stopped");
  assert.deepEqual(steer.log.stopped, ["w"]);
  assert.deepEqual(steer.log.started, []);
  assert.deepEqual(steer.log.watches, []);
});

test("a stopped one that couldn't be told stays stopped", async () => {
  const h = harness({ send: async () => false }, { row: working({ stage: "stopped" }) });
  await send(prompted("and this"), h);
  assert.equal(h.current()?.stage, "stopped");
  assert.deepEqual(said(h.log).at(-1), { type: "error", body: REPLIES.sendFailed });
});

test("re-delegated, or linked, while something's under way: they hear so", async () => {
  const held = new Map([[ISSUE, "another-agent-session"]]);
  const redelegated = racing({}, { held, row: working({ stage: "stopped", workspaceId: null, ask: askOf(created()) }) });
  await handleRedelegated(INSTALL, again, redelegated.deps);
  assert.deepEqual(said(redelegated.log), [{ type: "response", body: REPLIES.busy }]);
  const row = working({ stage: "awaiting_link", workspaceId: null, ask: askOf(created()) });
  const linked = racing({}, { held: new Map([[ISSUE, AGENT]]), row });
  await resumeAfterLink(INSTALL, row, linked.deps);
  assert.deepEqual(said(linked.log).at(-1), { type: "response", body: REPLIES.busy });
  assert.deepEqual(linked.log.started, []);
});

test("which repo, answered once the issue's closed: it's over", async () => {
  const h = harness(
    { linkedOwner: async () => "ana-user", standing: async () => ({ teamId: TEAM, delegateId: "app-user", open: false, stateType: "completed" }) },
    { row: working({ stage: "awaiting_repo", workspaceId: null, ask: askOf(created()), openWhenAsked: true }), scope: scope() },
  );
  await send(prompted("acme/web"), h);
  assert.deepEqual(h.log.started, []);
  assert.equal(h.current()?.stage, "stopped");
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.closedSince });
});

test("closed while it started, or as it was told: its turn stops and the item says so", async () => {
  // Closes as the session's made, and as it's told.
  let open = true;
  const standing = async () => ({ teamId: TEAM, delegateId: "app-user", open, stateType: open ? "started" : "completed" });
  const closes = async () => {
    open = false;
  };
  const started = harness({ standing, openWatch: closes }, { scope: scope({ defaultProjectId: WEB.id }), item: item() });
  await send(created(), started);
  assert.deepEqual(started.log.stopped, ["workspace-1"]);
  assert.equal(started.current()?.stage, "stopped");
  assert.match(started.log.notes.at(-1)?.body ?? "", /closed as its session was starting/);
  assert.deepEqual(said(started.log).at(-1), { type: "response", body: REPLIES.closedSince });
  assert.deepEqual(started.log.awaited, []);

  open = true;
  const told = harness(
    {
      standing,
      send: async () => {
        open = false;
        return true;
      },
    },
    { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) },
  );
  await send(created(), told);
  assert.deepEqual(told.log.stopped, ["w"]);
  assert.deepEqual(told.log.watches, []);
});

test("asked about an issue already closed: that's what they asked, so it goes on", async () => {
  const h = harness({ standing: async () => ({ teamId: TEAM, delegateId: "app-user", open: false, stateType: "completed" }) }, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created(), h);
  assert.equal(h.log.started.length, 1);
  assert.deepEqual(h.log.stopped, []);
  assert.equal(h.current()?.stage, "working");
});

test("while a session's being set up: a Stop says it stops once it's up, a reply that it's busy, and no second one starts", async () => {
  const setting = { session: async (id: string) => ({ id, ownerId: "ana-user", projectId: WEB.id, status: "provisioning" }) };
  const stop = harness({ ...setting, stop: async () => assert.fail("no turn to stop yet") }, { row: working() });
  await send(prompted("stop", { signal: "stop" }), stop);
  assert.equal(stop.current()?.stage, "stopped");
  assert.deepEqual(said(stop.log).at(-1), { type: "response", body: REPLIES.stoppingOnceUp });

  const reply = harness({ ...setting, send: async () => assert.fail("nothing can reach it") }, { row: working() });
  await send(prompted("and this"), reply);
  assert.deepEqual(said(reply.log).at(-1), { type: "response", body: REPLIES.busy });

  const steer = harness(setting, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
  await send(created(), steer);
  assert.deepEqual(steer.log.started, []);
  assert.deepEqual(said(steer.log).at(-1), { type: "response", body: REPLIES.busy });
});

test("asked about an issue already closed: answering or linking carries on, not told it's closed since", async () => {
  const closed = { standing: async () => ({ teamId: TEAM, delegateId: "app-user", open: false, stateType: "completed" }) };
  const repo = harness({ ...closed, linkedOwner: async () => "ana-user" }, { scope: scope() });
  await send(created(), repo);
  assert.equal(repo.current()?.stage, "awaiting_repo");
  assert.equal(repo.current()?.openWhenAsked, false);
  await send(prompted("acme/web"), repo);
  assert.equal(repo.log.started.length, 1);
  assert.equal(repo.current()?.stage, "working");

  let linked = false;
  const link = harness({ ...closed, linkedOwner: async () => (linked ? "ana-user" : null) }, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created(), link);
  const row = link.current() as AgentRow;
  assert.equal(row.stage, "awaiting_link");
  assert.equal(row.openWhenAsked, false);
  linked = true;
  await resumeAfterLink(INSTALL, row, link.deps);
  assert.equal(link.log.started.length, 1);
});

test("asked while it was open, then closed: that's what's refused", async () => {
  let open = true;
  const h = harness({ linkedOwner: async () => "ana-user", standing: async () => ({ teamId: TEAM, delegateId: "app-user", open, stateType: open ? "started" : "completed" }) }, { scope: scope() });
  await send(created(), h);
  assert.equal(h.current()?.openWhenAsked, true);
  open = false;
  await send(prompted("acme/web"), h);
  assert.deepEqual(h.log.started, []);
  assert.deepEqual(said(h.log).at(-1), { type: "response", body: REPLIES.closedSince });
});

test("a rule on an archived session someone else owns: it's gone, so a new one starts on its own slot", async () => {
  const session = async (id: string) => ({ id, ownerId: "ben-user", projectId: WEB.id, status: "archived" });
  for (const level of ["write", "read"] as const) {
    const h = harness({ session, level: async () => level }, { scope: scope({ acceptRuleSessions: true, defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
    await send(fromRule(), h);
    assert.deepEqual(h.log.sent, []);
    assert.equal(h.log.started.length, 1);
    assert.equal(h.log.slots, 1);
  }
  const live = harness({ session: async (id) => ({ id, ownerId: "ben-user", projectId: WEB.id, status: "ready" }), level: async () => "write" }, { scope: scope({ acceptRuleSessions: true, defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }) });
  await send(fromRule(), live);
  assert.deepEqual(live.log.started, [], "a live one isn't replaced");
  assert.equal(live.log.slots, 0);
});

// --- A stop can't be written over: each of these interleaves one where it could land.

const stopping = (h: () => ReturnType<typeof harness>) => async () => {
  await h().deps.stopRow(AGENT);
  return [WEB, API];
};

test("a Stop after a restart decided: it stands, whatever was about to be written", async () => {
  // Starting a session.
  const start: ReturnType<typeof harness> = harness({ projects: stopping(() => start) }, { scope: scope({ defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null, ask: askOf(created()) }) });
  await send(prompted("again"), start);
  assert.equal(start.current()?.stage, "stopped");
  assert.deepEqual(start.log.started, []);
  // Asking which repo.
  const asking: ReturnType<typeof harness> = harness({ projects: stopping(() => asking) }, { scope: scope(), row: working({ stage: "stopped", workspaceId: null, ask: askOf(created()) }) });
  await send(prompted("again"), asking);
  assert.equal(asking.current()?.stage, "stopped");
  assert.equal(said(asking.log).some((s) => s.body === REPLIES.whichRepo), false);
  // Asking to link.
  const linking: ReturnType<typeof harness> = harness(
    {
      linkedOwner: async () => {
        await linking.deps.stopRow(AGENT);
        return null;
      },
    },
    { scope: scope(), row: working({ stage: "stopped", workspaceId: null, ask: askOf(created()), ownerId: null }) },
  );
  await send(prompted("again"), linking);
  assert.equal(linking.current()?.stage, "stopped");
  assert.equal(said(linking.log).some((s) => s.body === REPLIES.link), false);
});

test("a Stop landing just as the row's written, or the slot's taken: nothing starts", async () => {
  const late: ReturnType<typeof harness> = harness(
    {
      claimRuleSession: async () => {
        await late.deps.stopRow(AGENT);
        return true;
      },
    },
    { scope: scope({ acceptRuleSessions: true, defaultProjectId: WEB.id }), row: working({ stage: "stopped", workspaceId: null, ruleStarted: true, ask: askOf(fromRule()) }) },
  );
  await send(prompted("again"), late);
  assert.deepEqual(late.log.started, []);
  assert.equal(late.current()?.stage, "stopped");
});

test("the row can't leave a Stop without a restart, nor a newer Stop with one", async () => {
  const h = harness({}, { row: working({ stage: "stopped", stopMark: "m" }) });
  const seen = h.current() as AgentRow;
  assert.equal(await h.deps.saveRow({ ...seen, stage: "working" }, seen), false);
  assert.equal(await h.deps.saveRow({ ...seen, stage: "working" }, seen, { restart: true }), true);
  await h.deps.stopRow(AGENT);
  assert.equal(await h.deps.saveRow({ ...seen, stage: "working" }, seen, { restart: true }), false);
  assert.equal(h.current()?.stage, "stopped");
});

test("a failed send puts back exactly what was there", async () => {
  const waiting = working({ stage: "awaiting_link", workspaceId: null, prompt: "As first asked", askedUser: "ana", ask: askOf(created()) });
  const h = harness({ send: async () => false, projects: async () => [] }, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }), row: waiting });
  await resumeAfterLink(INSTALL, waiting, h.deps);
  assert.equal(h.current()?.stage, "awaiting_link");
  assert.equal(h.current()?.prompt, "As first asked");
  assert.equal(h.current()?.workspaceId, null);
  assert.equal(h.current()?.askedUser, "ana");
});

test("un-delegated before there's a row: it's found, once there's one, and nothing goes on", async () => {
  const gone = { standing: async () => ({ teamId: TEAM, delegateId: null, open: true, stateType: "unstarted" }) };
  const start = harness(gone, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created(), start);
  assert.deepEqual(start.log.started, []);
  assert.equal(start.current()?.stage, "stopped");
  const asking = harness(gone, { scope: scope() });
  await send(created(), asking);
  assert.equal(asking.current()?.stage, "stopped");
  assert.equal(said(asking.log).some((s) => s.body === REPLIES.whichRepo), false);
  const linking = harness({ ...gone, linkedOwner: async () => null }, { scope: scope() });
  await send(created(), linking);
  assert.equal(linking.current()?.stage, "stopped");
  assert.equal(said(linking.log).some((s) => s.body === REPLIES.link), false);
  const steer = harness(gone, { scope: scope(), item: item({ workspaceId: "w" }) });
  await send(created(), steer);
  assert.equal(steer.current()?.stage, "stopped");
  assert.deepEqual(steer.log.stopped, ["w"], "told already, so interrupted");
  assert.deepEqual(steer.log.watches, []);

  // Someone else's delegate now counts too. An @mention isn't a delegation.
  const mention = harness(gone, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created({ session: { sourceMetadata: { type: "comment" } } }), mention);
  assert.equal(mention.log.started.length, 1);
  // A lookup that fails isn't an un-delegate.
  const failed = harness({ standing: async () => { throw new Error("down"); } }, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created(), failed);
  assert.equal(failed.log.started.length, 1);
});

test("what someone added for their restart names a repository for them, not whoever delegates next", async () => {
  const ask = { ...askOf(created()), said: "[repo=acme/api]", saidBy: "ana" };
  const row = working({ stage: "stopped", workspaceId: null, ask });
  const ben = harness({ linkedOwner: async () => "ben-user" }, { scope: scope({ defaultProjectId: WEB.id }), row });
  await handleRedelegated(INSTALL, { ...again, actorId: "ben", actorName: "Ben" }, ben.deps);
  assert.equal(ben.log.started[0]?.projectId, WEB.id);
  assert.doesNotMatch(ben.log.started[0]?.prompt ?? "", /They added/);
  const ana = harness({}, { scope: scope({ defaultProjectId: WEB.id }), row });
  await handleRedelegated(INSTALL, again, ana.deps);
  assert.equal(ana.log.started[0]?.projectId, API.id);
  // A rule's own start, on a row that kept it, isn't them either.
  const kept = harness({ creator: async () => ({ id: "zed", name: "Zed" }), linkedOwner: async () => "zed-user" }, { scope: scope({ acceptRuleSessions: true, defaultProjectId: WEB.id }), row });
  await handleRedelegated(INSTALL, { ...again, actorId: null, actorName: null }, kept.deps);
  assert.equal(kept.log.started[0]?.projectId, WEB.id);
});

test("a reply once the team's disconnected, or its issue has moved org: said so, and no turn", async () => {
  const off = harness({ send: async () => assert.fail("no turn") }, { scope: null, row: working() });
  await send(prompted("and this"), off);
  assert.deepEqual(said(off.log).at(-1), { type: "response", body: REPLIES.notConnected });
  const moved = harness({ send: async () => assert.fail("no turn") }, { scope: scope({ orgId: "another-org" }), row: working() });
  await send(prompted("and this"), moved);
  assert.deepEqual(said(moved.log).at(-1), { type: "response", body: REPLIES.notConnected });
});

test("what was kept of an issue may be old: Linear's asked which team it's in now", async () => {
  const OLD = "old-team";
  const NEW = "new-team";
  const byTeam = {
    standing: async () => ({ teamId: NEW, delegateId: "app-user", open: true, stateType: "started" }),
    scopeForTeam: async (_i: string, team: string) => scope({ orgId: team === OLD ? "org" : "another-org", externalTeamId: team, defaultProjectId: WEB.id }),
    linkedOwner: async () => "ana-user",
  };
  const ask = askOf(created({ issue: { teamId: OLD } }));
  const answer = harness(byTeam, { row: working({ stage: "awaiting_repo", workspaceId: null, ask }) });
  await send(prompted("acme/web"), answer);
  assert.deepEqual(answer.log.started, []);
  assert.deepEqual(said(answer.log).at(-1), { type: "response", body: REPLIES.notConnected });
  const row = working({ stage: "awaiting_link", workspaceId: null, ask });
  let filedIn: string | undefined;
  const resume = harness({ ...byTeam, triageActor: async (u, o) => ((filedIn = o), actor(u)) }, { row });
  await resumeAfterLink(INSTALL, row, resume.deps);
  assert.equal(filedIn, "another-org");
});

test("a slot taken for what's still waiting isn't taken again", async () => {
  const on = { scope: scope({ acceptRuleSessions: true, defaultProjectId: null }), item: item({ workspaceId: "w" }) };
  // Steered, the send failed, and no repo is settled.
  const h = harness({ send: async () => false, linkedOwner: async () => "ana-user" }, on);
  await send(fromRule(), h);
  assert.equal(h.log.slots, 1);
  assert.equal(h.current()?.stage, "awaiting_repo");
  assert.equal(h.current()?.slotTaken, true);
  await send(prompted("acme/web"), h);
  assert.equal(h.log.started.length, 1);
  assert.equal(h.log.slots, 1, "the answer doesn't take another");
  assert.ok(!h.current()?.slotTaken, "spent");
});

test("delegated while a question waits on someone: told what it's waiting on, and nothing changes", async () => {
  const later = { ...again, actorId: "ben", actorName: "Ben", at: AT + 60_000 };
  const repo = working({ stage: "awaiting_repo", workspaceId: null, sessionCreatedAt: AT, ask: askOf(created()) });
  const h = harness({}, { row: repo });
  await handleRedelegated(INSTALL, later, h.deps);
  assert.deepEqual(said(h.log), [{ type: "response", body: REPLIES.stillAskingRepo }]);
  assert.equal(h.current()?.stage, "awaiting_repo");
  const link = harness({}, { row: { ...repo, stage: "awaiting_link" } });
  await handleRedelegated(INSTALL, later, link.deps);
  assert.deepEqual(said(link.log), [{ type: "response", body: REPLIES.stillAskingLink }]);
  // Its own delegation's change has nothing to say.
  const own = harness({}, { row: repo });
  await handleRedelegated(INSTALL, { ...later, at: AT + 50 }, own.deps);
  assert.deepEqual(own.log.said, []);
});

test("'this carries on' is only said where something will", async () => {
  const unlinked = { linkedOwner: async () => null };
  const reply = harness(unlinked, { row: working() });
  await send(prompted("and this", { userId: "zed" }), reply);
  assert.deepEqual(said(reply.log).at(-1), { type: "response", body: REPLIES.linkThenSay });
  const restart = harness(unlinked, { row: working({ stage: "stopped", workspaceId: null, ask: askOf(created()) }) });
  await send(prompted("again", { userId: "zed" }), restart);
  assert.deepEqual(said(restart.log).at(-1), { type: "response", body: REPLIES.linkThenSay });
  const nobody = harness(unlinked, {});
  await send(prompted("again", { userId: null }), nobody);
  assert.deepEqual(said(nobody.log).at(-1), { type: "response", body: REPLIES.linkThenSay });
  assert.equal(nobody.current(), null);
});

test("Linear's suggestion reads anyone's text, so it only counts on the runner's own issue", async () => {
  const suggests = { suggestions: async () => [{ repositoryFullName: API.fullName, confidence: 0.95 }] };
  const theirs = harness(suggests, { scope: scope() });
  await send(created(), theirs);
  assert.equal(theirs.log.started[0]?.projectId, API.id);
  const told = said(theirs.log).findIndex((s) => s.type === "thought" && s.body.includes(API.fullName) && s.body.includes("Linear suggested"));
  assert.ok(told >= 0, "says which repository, and why");
  assert.deepEqual(theirs.log.urls.length, 1);

  // Settled any other way, there's nothing to say.
  const tagged = harness(suggests, { scope: scope({ defaultProjectId: WEB.id }) });
  await send(created(), tagged);
  assert.equal(tagged.log.started[0]?.projectId, WEB.id);
  assert.equal(said(tagged.log).some((s) => s.body.includes("Linear suggested")), false);

  const someoneElses = harness({ ...suggests, creator: async () => ({ id: "zed", name: "Zed" }) }, { scope: scope() });
  await send(created(), someoneElses);
  assert.deepEqual(someoneElses.log.started, []);
  assert.equal(someoneElses.current()?.stage, "awaiting_repo");
  assert.equal(said(someoneElses.log).at(-1)?.body, REPLIES.whichRepo);
  assert.equal(said(someoneElses.log).some((s) => s.body.includes("Linear suggested")), false);

  const unknown = harness({ ...suggests, creator: async () => { throw new Error("down"); } }, { scope: scope() });
  await send(created(), unknown);
  assert.equal(unknown.current()?.stage, "awaiting_repo", "not known to be theirs");
});

test("a run on Linear's suggestion says so before it starts", async () => {
  const order: string[] = [];
  const h = harness(
    {
      suggestions: async () => [{ repositoryFullName: API.fullName, confidence: 0.95 }],
      say: async (_i, _a, content) => void order.push(content.body),
      start: async (start) => {
        order.push("started");
        await start.onCreated?.("workspace-1");
        return { workspaceId: "workspace-1", status: "ready" } as ServerSessionResult;
      },
    },
    { scope: scope() },
  );
  await send(created(), h);
  const told = order.findIndex((body) => body.includes("Linear suggested"));
  assert.ok(told >= 0 && told < order.indexOf("started"), "told first");
});

test("un-delegated again while a re-delegation is under way: it's found once the row's written, and nothing starts", async () => {
  const row = working({ stage: "stopped", workspaceId: null, ask: askOf(created()) });
  const gone = { standing: async () => ({ teamId: TEAM, delegateId: null, open: true, stateType: "unstarted" }) };
  const start = harness(gone, { scope: scope({ defaultProjectId: WEB.id }), row });
  await handleRedelegated(INSTALL, again, start.deps);
  assert.deepEqual(start.log.started, []);
  assert.equal(start.current()?.stage, "stopped");
  const steer = harness(gone, { scope: scope({ defaultProjectId: WEB.id }), item: item({ workspaceId: "w" }), row });
  await handleRedelegated(INSTALL, again, steer.deps);
  assert.deepEqual(steer.log.stopped, ["w"], "told already, so interrupted");
  assert.deepEqual(steer.log.watches, []);
  // A reply starting a stopped one again isn't a delegation, and needs none.
  const reply = harness(gone, { scope: scope({ defaultProjectId: WEB.id }), row });
  await send(prompted("again"), reply);
  assert.equal(reply.log.started.length, 1);
});

// --- Blocked, and started again

const BLOCKING = { started: "st-progress", inReview: "st-review", done: null, blocked: "st-blocked" };
const at = (stateId: string, stateType: string) => async () => ({ teamId: TEAM, delegateId: "app-user", open: true, stateId, stateType });

test("waiting on someone, or a start that failed: the issue goes to Blocked", async () => {
  const repo = harness({ standing: at("st-todo", "unstarted") }, { scope: scope({ stateMap: BLOCKING }) });
  await send(created(), repo);
  assert.equal(repo.current()?.stage, "awaiting_repo");
  assert.deepEqual(repo.log.states, ["st-blocked"]);

  const link = harness({ standing: at("st-todo", "unstarted"), linkedOwner: async () => null }, { scope: scope({ stateMap: BLOCKING }) });
  await send(created(), link);
  assert.equal(link.current()?.stage, "awaiting_link");
  assert.deepEqual(link.log.states, ["st-blocked"]);

  const failed = harness(
    { standing: at("st-progress", "started"), start: async (start) => (await start.onCreated?.("workspace-1"), { workspaceId: "workspace-1", status: "failed", errorMessage: "no box" } as ServerSessionResult) },
    { scope: scope({ stateMap: BLOCKING, defaultProjectId: WEB.id }) },
  );
  await send(created(), failed);
  assert.equal(failed.log.states.at(-1), "st-blocked");

  // No Blocked state, or the issue closed: nothing moves.
  const off = harness({ standing: at("st-todo", "unstarted") }, { scope: scope({ stateMap: { ...BLOCKING, blocked: null } }) });
  await send(created(), off);
  assert.deepEqual(off.log.states, []);
  const closed = harness({ standing: at("st-done", "completed") }, { scope: scope({ stateMap: BLOCKING }) });
  await send(created(), closed);
  assert.deepEqual(closed.log.states, []);
});

test("work picking up moves a Blocked issue back to started: a reply, a steer, or a start", async () => {
  const reply = harness({ standing: at("st-blocked", "started") }, { row: working(), scope: scope({ stateMap: BLOCKING }) });
  await send(prompted("and this"), reply);
  assert.equal(reply.log.sent.length, 1);
  assert.deepEqual(reply.log.states, ["st-progress"]);

  const steer = harness({ standing: at("st-blocked", "started") }, { scope: scope({ stateMap: BLOCKING }), item: item({ workspaceId: "w" }) });
  await send(created(), steer);
  assert.equal(steer.log.sent.length, 1);
  assert.deepEqual(steer.log.states, ["st-progress"]);

  const start = harness({ standing: at("st-blocked", "started") }, { scope: scope({ stateMap: BLOCKING, defaultProjectId: WEB.id }) });
  await send(created(), start);
  assert.equal(start.log.started.length, 1);
  assert.deepEqual(start.log.states, ["st-progress"]);

  // Already where a person or a session put it: it stays.
  const inReview = harness({ standing: at("st-review", "started") }, { row: working(), scope: scope({ stateMap: BLOCKING }) });
  await send(prompted("and this"), inReview);
  assert.deepEqual(inReview.log.states, []);
});
