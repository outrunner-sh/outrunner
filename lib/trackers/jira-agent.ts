/**
 * An issue assigned to Outrunner's Jira account, or that account @mentioned on it, and the
 * session here that answers (docs/jira-app.md). Jira has no agent sessions, so this is
 * comments, and one row per issue.
 *
 * Whose session it is: the person who assigned or mentioned, if they've linked their
 * account and are in the org that owns the project. An Automation rule has no person behind
 * it, so an org admin has to have turned those on, and it runs as the issue's creator, never
 * its reporter, whom anyone with edit rights can change. It's never the installer, or whoever
 * set a rule here. A slot of the project's day goes only as a session really starts. Anyone
 * else who isn't a person, such as a portal customer, gets a reply, and nothing runs.
 *
 * A stop always wins: a row never comes back from stopped by itself, and a session set up
 * meanwhile is interrupted once it's up.
 *
 * All of it runs after the webhook has answered, as a session takes minutes to start. So
 * what goes wrong is said on the issue, as nothing makes Jira deliver it again.
 */

import { blockedTarget, type IssueState, startedTarget } from "@/lib/trackers/rules";
import type { AccessLevel } from "@/lib/orgs/access";
import { allows } from "@/lib/orgs/access";
import type { JiraRow } from "@/lib/db/jira-sessions";
import type { TrackerInstallation, TrackerScope } from "@/lib/db/trackers";
import type { TrackerFiling, TrackerNote } from "@/lib/db/work-items";
import { OUTRUNNER_MODELS } from "@/lib/runtime/session-models";
import { SETTING_UP } from "@/lib/session/provisioning";
import type { ServerSessionResult, ServerSessionStart } from "@/lib/session/server-session";
import type { JiraIssueStanding } from "@/lib/trackers/jira";
import { branchHint } from "@/lib/trackers/issue-key";
import { pickModel, pickRepo, type Project, repoFromReply } from "@/lib/trackers/linear-agent";
import type { TriageActor } from "@/lib/triage/access";
import { cutText, MAX_BODY, MAX_TITLE, type WorkItem } from "@/lib/triage/work-items";

const SOURCE = "jira" as const;
/** A comment listing more than this is a long way to scroll. */
const MAX_LISTED = 25;

export const JIRA_REPLIES = {
  notConnected: "This project isn't connected to an Outrunner org. An org admin connects it under Settings → Org → Integrations → Jira.",
  rulesOff: "Rule-started sessions are off for this project in Outrunner.",
  noPerson: "This issue wasn't created by a person, so there's no one to run its session as.",
  notMember: "Your Jira account is linked, but you aren't in the Outrunner org this project belongs to.",
  noRepos: "You can't read any repository in the Outrunner org this project belongs to.",
  cantSteer: "This session is someone else's, and you need write access to its repository to steer it.",
  busy: "Outrunner is still setting up this issue's session. Mention it again once it's started.",
  closedSince: "This issue has closed since, so nothing started. Assign or mention Outrunner again if it's still wanted.",
  notYours: "Outrunner is waiting on whoever asked first to say which repository. It runs on their account, so it's theirs to answer.",
  notAPerson: "Only someone on this site with a linked account, or an Automation rule, can start a session.",
  ruleDeclined: "This issue was declined in Outrunner, so a rule won't start it. Assigning it yourself will.",
} as const;

export function jiraCapReply(cap: number): string {
  return `This project's limit of ${cap} rule-started sessions today is reached.`;
}

/** Who did it: `rule` is Automation for Jira and other apps; `other` isn't a person or an
 *  app, such as a portal customer. */
export type JiraActor = { id: string | null; name: string | null; kind: "person" | "rule" | "other" };

export type JiraTrigger = {
  /** `reply`: a comment naming a repository, which only counts if one was asked for. */
  kind: "assigned" | "mentioned" | "reply";
  issueId: string;
  actor: JiraActor;
  /** What the comment or description said, as plain text. */
  text: string | null;
  /** The comment that said it. */
  commentId?: string | null;
  /** Carrying on what was asked before they linked: `text` is what was kept of it. */
  resuming?: boolean;
};

export type JiraAgentDeps = {
  comment(installationId: string, issueId: string, body: string): Promise<void>;
  remoteLink(installationId: string, issueId: string, url: string, title: string): Promise<void>;
  transition(installationId: string, issueId: string, statusId: string): Promise<boolean>;
  standing(installationId: string, issueId: string): Promise<JiraIssueStanding | null>;
  scopeForTeam(installationId: string, projectId: string): Promise<TrackerScope | null>;
  claimRuleSession(scopeId: string): Promise<boolean>;
  linkedOwner(installationId: string, externalUserId: string): Promise<string | null>;
  triageActor(userId: string, orgId: string): Promise<TriageActor | null>;
  projects(orgId: string): Promise<Project[]>;
  level(userId: string, projectId: string): Promise<AccessLevel | null>;
  item(orgId: string, sourceRef: string): Promise<WorkItem | null>;
  file(actor: TriageActor, filing: TrackerFiling, installationId: string): Promise<WorkItem | null>;
  linkItem(orgId: string, itemId: string, session: { workspaceId: string; projectId: string }): Promise<void>;
  addNote(orgId: string, itemId: string, note: TrackerNote): Promise<void>;
  row(installationId: string, issueId: string): Promise<JiraRow | null>;
  /** False, with nothing written, if a stop has landed since `seen`, the row this was decided
   *  from: see saveJiraRow. Nothing else changes a stage, but stopRow. */
  saveRow(row: JiraRow, seen: JiraRow | null): Promise<boolean>;
  /** Its session, once made. Leaves the stage: a stop during setup stays a stop. */
  setRowWorkspace(installationId: string, issueId: string, workspaceId: string): Promise<void>;
  stopRow(installationId: string, issueId: string): Promise<void>;
  claim(installationId: string, issueId: string): Promise<boolean>;
  release(installationId: string, issueId: string): Promise<void>;
  session(workspaceId: string): Promise<{ id: string; ownerId: string; projectId: string | null; status: string } | null>;
  start(start: ServerSessionStart): Promise<ServerSessionResult>;
  send(ownerId: string, workspaceId: string, text: string): Promise<boolean>;
  stop(ownerId: string, workspaceId: string): Promise<boolean>;
  /** A branch named for the issue, free in that project. */
  branchFor(projectId: string, key: string, title: string): Promise<string>;
  /** Where its conversation is, before a send: activity after it is that send's turn. */
  sendBaseline(workspaceId: string): Promise<number | null>;
  /** A turn was sent: from now on the relay and the tick watch it. */
  openWatch(installationId: string, issueId: string, sent: { sentAt: number; baselineActivity: number | null }): Promise<void>;
  /** Watch a while; the tick carries on after. */
  watchReply(installationId: string, issueId: string): Promise<void>;
  now(): number;
  linkUrl(): string;
  sessionUrl(workspaceId: string): string;
};

type Context = { installation: TrackerInstallation; trigger: JiraTrigger; deps: JiraAgentDeps; issueId: string };

export function jiraIssueRef(cloudId: string, issueId: string): string {
  return `${SOURCE}:${cloudId}/${issueId}`;
}

export function jiraIssueUrl(installation: { siteUrl: string | null }, key: string | null): string | null {
  return installation.siteUrl && key ? `${installation.siteUrl.replace(/\/$/, "")}/browse/${key}` : null;
}

/** The session's first prompt: the issue, and what was asked of it. */
export function jiraFirstPrompt(installation: TrackerInstallation, standing: JiraIssueStanding, trigger: JiraTrigger): string {
  const url = jiraIssueUrl(installation, standing.key);
  const parts = [`Work on Jira issue ${standing.key ?? ""}: ${standing.title}`.replace("  ", " ")];
  if (url) parts.push(`(${url})`);
  // The branch it's on already has it. Should the agent ever name its own, the link stays.
  if (standing.key) parts.push(branchHint("jira", standing.key));
  if (standing.description) parts.push(standing.description);
  if (trigger.text && trigger.kind === "mentioned") parts.push(`${trigger.actor.name ?? "Someone"} said in Jira: ${trigger.text}`);
  return cutText(parts.join("\n\n"), MAX_BODY);
}

function reposListed(readable: readonly Project[]): string {
  const shown = readable.slice(0, MAX_LISTED).map((p) => `- ${p.fullName}`);
  if (readable.length > MAX_LISTED) shown.push(`- and ${readable.length - MAX_LISTED} more`);
  return shown.join("\n");
}

function askRepoComment(readable: readonly Project[], lead: string): string {
  return `${lead} Reply with repo=owner/name.\n\n${reposListed(readable)}`;
}

/**
 * Handle a trigger, after the webhook has answered. Only one event acts on an issue at a
 * time, until a session is up or a send has gone: an assign and an @mention together must not
 * start two sessions.
 */
export async function handleJiraTrigger(installation: TrackerInstallation, trigger: JiraTrigger, deps: JiraAgentDeps): Promise<void> {
  const issueId = trigger.issueId;
  const context: Context = { installation, trigger, deps, issueId };
  try {
    // Any comment can name a repository: only one that answers something is worth more.
    if (trigger.kind === "reply" && (await deps.row(installation.id, issueId))?.stage !== "awaiting_repo") return;
    if (!(await deps.claim(installation.id, issueId))) {
      // An assign says nothing the one under way isn't acting on. Words would be lost.
      if (trigger.kind === "mentioned" || trigger.resuming) await deps.comment(installation.id, issueId, JIRA_REPLIES.busy);
      return;
    }
  } catch (error) {
    console.error("Jira: couldn't take an issue", error);
    return;
  }
  let watching = false;
  try {
    watching = await delegate(context);
  } catch (error) {
    console.error("Jira: a delegation failed", error);
    await deps
      .comment(installation.id, issueId, "Something went wrong in Outrunner, so this didn't start. Try again.")
      .catch((commentError: unknown) => console.error("Jira: couldn't say a delegation failed", commentError));
  } finally {
    await deps.release(installation.id, issueId).catch((error: unknown) => console.error("Jira: couldn't let go of an issue", error));
  }
  // Outside the hold: it's up, so what anyone says next has somewhere to go.
  if (watching) await deps.watchReply(installation.id, issueId).catch((error: unknown) => console.error("Jira: couldn't watch a turn", error));
}

/** Someone just linked: what they asked for carries on, as first asked. It may be a day
 *  later, and what was asked may be over. */
export async function resumeJiraAfterLink(installation: TrackerInstallation, row: JiraRow, deps: JiraAgentDeps): Promise<void> {
  const standing = await deps.standing(installation.id, row.issueId);
  if (!standing) return;
  // Only if it's closed since: someone may well ask about an issue that's closed.
  if (!standing.open && row.openWhenAsked) {
    await deps.stopRow(installation.id, row.issueId);
    await deps.comment(installation.id, row.issueId, JIRA_REPLIES.closedSince);
    return;
  }
  await handleJiraTrigger(
    installation,
    {
      kind: "assigned",
      issueId: row.issueId,
      actor: { id: row.askedUser ?? null, name: null, kind: row.ruleStarted ? "rule" : "person" },
      text: row.askText ?? null,
      commentId: row.commentId ?? null,
      resuming: true,
    },
    deps,
  );
}

function rowOf(context: Context, over: Partial<JiraRow>): JiraRow {
  return {
    installationId: context.installation.id,
    issueId: context.issueId,
    orgId: null,
    itemId: null,
    workspaceId: null,
    ownerId: null,
    stage: "working",
    prompt: null,
    ruleStarted: false,
    ...over,
  };
}

const SETUP_STATUSES: ReadonlySet<string> = new Set(SETTING_UP);

type Runner = {
  actor: TriageActor;
  ruleStarted: boolean;
  /** Their Jira id, when known: whose words count as theirs. */
  externalId: string | null;
  /** A slot of the day's already spent on this. */
  slotTaken?: boolean;
};

/**
 * What can name a repository or model, on the runner's account and allowance: their own words,
 * and only those. Not the description, even of an issue they made: anyone who can edit it can
 * edit that, and someone else mustn't pick where they run.
 */
function tagWords(trigger: JiraTrigger, runner: Runner): string | null {
  return trigger.actor.kind === "person" && trigger.actor.id === runner.externalId ? trigger.text : null;
}

/** Who it runs as, having said why when it's no one. No slot of the day yet: that goes only
 *  as a session really starts. */
async function resolveRunner(context: Context, scope: TrackerScope, standing: JiraIssueStanding, seen: JiraRow | null): Promise<Runner | null> {
  const { installation, trigger, deps, issueId } = context;
  const say = (body: string) => deps.comment(installation.id, issueId, body);
  if (trigger.actor.kind === "other") {
    await say(JIRA_REPLIES.notAPerson);
    return null;
  }
  const ruleStarted = trigger.actor.kind === "rule";
  let externalId = trigger.actor.id;
  if (ruleStarted) {
    if (!scope.acceptRuleSessions) {
      await say(JIRA_REPLIES.rulesOff);
      return null;
    }
    if (!standing.creatorId || standing.creatorId === installation.appUserId) {
      await say(JIRA_REPLIES.noPerson);
      return null;
    }
    externalId = standing.creatorId;
  }
  if (!externalId) {
    await say(JIRA_REPLIES.noPerson);
    return null;
  }
  const owner = await deps.linkedOwner(installation.id, externalId);
  if (!owner) {
    // One row an issue: someone else's session or question stays theirs, and this one is told
    // to ask again after linking.
    if (seen && (seen.workspaceId !== null || seen.stage === "awaiting_repo")) {
      await say(`Link your Jira account to Outrunner, then mention Outrunner here again: ${deps.linkUrl()}`);
      return null;
    }
    const written = await deps.saveRow(rowOf(context, { orgId: scope.orgId, teamId: scope.externalTeamId, openWhenAsked: standing.open, stage: "awaiting_link", prompt: jiraFirstPrompt(installation, standing, trigger), ruleStarted, commentId: trigger.commentId ?? null, askedUser: externalId, askText: trigger.kind === "mentioned" ? trigger.text : null }), seen);
    if (!written) return null;
    await moveIssue(context, scope, standing, blockedTarget, "blocked");
    await say(`Link your Jira account to Outrunner, and this carries on: ${deps.linkUrl()}`);
    return null;
  }
  const actor = await deps.triageActor(owner, scope.orgId);
  if (!actor) {
    await say(JIRA_REPLIES.notMember);
    return null;
  }
  return { actor, ruleStarted, externalId };
}

/** The answer to which repository: only from whoever it would run as, and only if it was
 *  asked. An @mention of ours answers too, as replying here takes one. Null: not an answer.
 *  Otherwise whether there's now a turn to watch. */
async function answerRepo(context: Context, scope: TrackerScope | null, standing: JiraIssueStanding, row: JiraRow | null): Promise<boolean | null> {
  const { installation, trigger, deps, issueId } = context;
  if (trigger.kind === "assigned" || row?.stage !== "awaiting_repo" || !row.ownerId || !trigger.actor.id) return null;
  const say = (body: string) => deps.comment(installation.id, issueId, body);
  if ((await deps.linkedOwner(installation.id, trigger.actor.id)) !== row.ownerId) {
    // Anyone's comment may name a repository, and says nothing. A mention was meant for us.
    if (trigger.kind === "mentioned") await say(JIRA_REPLIES.notYours);
    return false;
  }
  if (!scope || scope.orgId !== row.orgId) {
    await say(JIRA_REPLIES.notConnected);
    return false;
  }
  // It may be a day later: what was asked may be over. Only if it's closed since: someone may
  // well ask about an issue that's closed.
  if (!standing.open && row.openWhenAsked) {
    await deps.stopRow(installation.id, issueId);
    await say(JIRA_REPLIES.closedSince);
    return false;
  }
  const actor = await deps.triageActor(row.ownerId, scope.orgId);
  if (!actor) {
    await say(JIRA_REPLIES.notMember);
    return false;
  }
  const readable = (await deps.projects(scope.orgId)).filter((p) => actor.levels.has(p.id));
  const chosen = repoFromReply(trigger.text, readable);
  if (!chosen) {
    await say(askRepoComment(readable, "That isn't one of the repositories you can use."));
    return false;
  }
  const item = await deps.item(scope.orgId, jiraIssueRef(installation.externalId, issueId));
  const prompt = row.prompt ?? jiraFirstPrompt(installation, standing, trigger);
  // Their first words may have named a model, as well as this one naming a repository.
  const answered: Context = row.askText ? { ...context, trigger: { ...trigger, text: [trigger.text, row.askText].filter(Boolean).join("\n") } } : context;
  return startSession(answered, scope, standing, { actor, ruleStarted: row.ruleStarted, externalId: trigger.actor.id, slotTaken: row.slotTaken }, item, chosen, prompt, row);
}

/** Holding the issue. Whether there's now a turn to watch. */
async function delegate(context: Context): Promise<boolean> {
  const { installation, trigger, deps, issueId } = context;
  const say = (body: string) => deps.comment(installation.id, issueId, body);
  // What everything below is decided from: a stop after this means none of it goes through.
  const row = await deps.row(installation.id, issueId);
  const standing = await deps.standing(installation.id, issueId);
  if (!standing) return false;
  // Assigned away again already: its event finds a row that only reads as stopped. Jira's asked
  // after that read: if it changed before this, this sees it, and if after, the mark's new.
  if (trigger.kind === "assigned" && !trigger.resuming && standing.assigneeId !== installation.appUserId) return false;
  const scope = await deps.scopeForTeam(installation.id, standing.teamId);

  const answered = await answerRepo(context, scope, standing, row);
  if (answered !== null) return answered;
  // A comment naming a repository that answers nothing is only a comment.
  if (trigger.kind === "reply") return false;

  if (!scope) {
    await say(JIRA_REPLIES.notConnected);
    return false;
  }
  const runner = await resolveRunner(context, scope, standing, row);
  if (!runner) return false;
  if (row?.slotTaken) runner.slotTaken = true;
  const { actor } = runner;

  const item = await deps.item(scope.orgId, jiraIssueRef(installation.externalId, issueId));
  // A person may hand back what was decided here. A rule can't overrule them.
  if (runner.ruleStarted && (item?.status === "declined" || item?.status === "duplicate")) {
    await say(JIRA_REPLIES.ruleDeclined);
    return false;
  }
  // Carrying on after a link: as first asked.
  const prompt = trigger.resuming && row?.prompt ? row.prompt : jiraFirstPrompt(installation, standing, trigger);

  // A session it already has hears of it: woken or restored if it must be. One that can't
  // be reached is replaced. One that's live and someone else's isn't taken over.
  // A row another org left behind can't hold this org up.
  const workspaceId = (row?.orgId === scope.orgId ? row.workspaceId : null) ?? item?.workspaceId ?? null;
  const session = workspaceId ? await deps.session(workspaceId) : null;
  if (session) {
    const reachable = session.ownerId === actor.userId || (session.projectId !== null && allows(await deps.level(actor.userId, session.projectId), "write"));
    // Nothing can reach it yet, and it isn't lost: starting another would be two.
    if (reachable && SETUP_STATUSES.has(session.status)) {
      await say(JIRA_REPLIES.busy);
      return false;
    }
    const may = session.ownerId === actor.userId || (session.projectId !== null && allows(await deps.level(actor.userId, session.projectId), "write"));
    // A session in these isn't live: nothing it holds is worth protecting.
    if (!may && !["archived", "archiving", "destroying", "destroyed"].includes(session.status)) {
      await say(JIRA_REPLIES.cantSteer);
      return false;
    }
    // A rule steers only what its runner owns: anyone else's may be on their own keys. It's
    // still work a rule started, so it counts against the day.
    if (runner.ruleStarted && may && session.ownerId !== actor.userId && !["archived", "archiving", "destroying", "destroyed"].includes(session.status)) {
      await say(JIRA_REPLIES.cantSteer);
      return false;
    }
    if (runner.ruleStarted && may && session.ownerId === actor.userId && !["archiving", "destroying", "destroyed"].includes(session.status)) {
      if (!runner.slotTaken && !(await deps.claimRuleSession(scope.id))) {
        await say(jiraCapReply(scope.ruleSessionsPerDay));
        return false;
      }
      runner.slotTaken = true;
    }
    const steering = may && !["archiving", "destroying", "destroyed"].includes(session.status) && (!runner.ruleStarted || session.ownerId === actor.userId);
    if (steering) {
      const message = row?.workspaceId && trigger.text ? `${trigger.actor.name ?? "Someone"} (in Jira): ${trigger.text}` : prompt;
      const baselineActivity = await deps.sendBaseline(session.id).catch(() => null);
      const sentAt = deps.now();
      const next = rowOf(context, { orgId: scope.orgId, teamId: scope.externalTeamId, itemId: item?.id ?? null, workspaceId: session.id, ownerId: session.ownerId });
      // Written before it goes: being assigned away while it's on its way is one to find. If
      // it doesn't go, what was there goes back.
      if (row && !(await deps.saveRow(next, row))) return false;
      const sent = await deps.send(session.ownerId, session.id, message).catch(() => false);
      if (!sent && row) await deps.saveRow(row, row);
      if (sent) {
        if (row ? (await deps.row(installation.id, issueId))?.stage === "stopped" : !(await deps.saveRow(next, null))) {
          await deps.stop(session.ownerId, session.id).catch((error: unknown) => console.warn("Jira: couldn't interrupt a session stopped as it was told", error));
          return false;
        }
        if (standing.open && (await closedSince(context, scope, item, session.ownerId, session.id))) return false;
        if (item && session.projectId) await deps.linkItem(scope.orgId, item.id, { workspaceId: session.id, projectId: session.projectId });
        await deps.openWatch(installation.id, issueId, { sentAt, baselineActivity });
        await moveToStarted(context, scope, standing);
        return true;
      }
    }
  }

  const readable = (await deps.projects(scope.orgId)).filter((p) => actor.levels.has(p.id));
  if (readable.length === 0) {
    await say(JIRA_REPLIES.noRepos);
    return false;
  }
  const picked = pickRepo({
    comment: tagWords(trigger, runner),
    itemProjectId: item?.projectId ?? null,
    defaultProjectId: scope.defaultProjectId,
    guidance: [],
    readable,
  });
  if (!picked) {
    // Only a person's own words can name a model, and a repeat of the question keeps what it had.
    const said = !runner.ruleStarted && (trigger.kind === "mentioned" || trigger.resuming) ? trigger.text : null;
    const askText = said ?? (row?.ownerId === actor.userId ? row.askText : null) ?? null;
    const written = await deps.saveRow(rowOf(context, { orgId: scope.orgId, teamId: scope.externalTeamId, openWhenAsked: standing.open, slotTaken: runner.slotTaken, itemId: item?.id ?? null, ownerId: actor.userId, stage: "awaiting_repo", prompt, ruleStarted: runner.ruleStarted, commentId: trigger.commentId ?? null, askText }), row);
    if (!written) return false;
    await moveIssue(context, scope, standing, blockedTarget, "blocked");
    await say(askRepoComment(readable, "Which repository should this run on?"));
    return false;
  }
  return startSession(context, scope, standing, runner, item, picked, prompt, row);
}

/**
 * Closed while this was on its way: archiving passes over a session still being set up, so it's
 * for this to stop. Only if it was open when this began: someone may well ask about an issue
 * that's closed. The session stays.
 */
async function closedSince({ installation, deps, issueId }: Context, scope: TrackerScope, item: WorkItem | null, ownerId: string, workspaceId: string): Promise<boolean> {
  const standing = await deps.standing(installation.id, issueId).catch(() => null);
  if (!standing || standing.open) return false;
  await deps.stopRow(installation.id, issueId);
  await deps.stop(ownerId, workspaceId).catch((error: unknown) => console.warn("Jira: couldn't interrupt a session whose issue closed", error));
  if (item) {
    await deps.addNote(scope.orgId, item.id, {
      authorId: null,
      body: "The issue closed as its session was starting, so its turn stopped. The session stays.",
      source: SOURCE,
      sourceUrl: jiraIssueUrl(installation, standing.key),
      author: "Jira",
      sourceRef: `${SOURCE}:${issueId}:closed:${workspaceId}`,
    });
  }
  await deps.comment(installation.id, issueId, JIRA_REPLIES.closedSince);
  return true;
}

/** A rule's takes a slot of the project's day here, and nowhere sooner. */
async function startSession(
  context: Context,
  scope: TrackerScope,
  standing: JiraIssueStanding,
  runner: Runner,
  existing: WorkItem | null,
  project: Project,
  prompt: string,
  seen: JiraRow | null,
): Promise<boolean> {
  const { installation, trigger, deps, issueId } = context;
  const { actor } = runner;
  const ref = jiraIssueRef(installation.externalId, issueId);
  const url = jiraIssueUrl(installation, standing.key);
  const title = cutText(standing.title.replace(/\s+/g, " "), MAX_TITLE);

  // Stopped while this was deciding: it isn't to start, and nothing's been spent.
  const now = await deps.row(installation.id, issueId);
  if (seen ? (now?.stopMark ?? null) !== (seen.stopMark ?? null) : now) return false;
  if (runner.ruleStarted && !runner.slotTaken && !(await deps.claimRuleSession(scope.id))) {
    await deps.comment(installation.id, issueId, jiraCapReply(scope.ruleSessionsPerDay));
    return false;
  }

  const { model, unknown } = pickModel(tagWords(trigger, runner));
  if (unknown) {
    await deps.comment(installation.id, issueId, `There's no model called ${unknown} here, so this runs on the default. Available: ${OUTRUNNER_MODELS.map((m) => m.id).join(", ")}.`);
  }

  const item =
    existing ??
    (await deps.file(
      actor,
      {
        title,
        body: cutText(standing.description, MAX_BODY),
        projectId: project.id,
        source: SOURCE,
        sourceUrl: url,
        sourceRef: ref,
        sourceAuthor: standing.creatorName,
      },
      installation.id,
    )) ??
    (await deps.item(scope.orgId, ref));

  if (!(await deps.saveRow(rowOf(context, { orgId: scope.orgId, teamId: scope.externalTeamId, itemId: item?.id ?? null, ownerId: actor.userId, ruleStarted: runner.ruleStarted }), seen))) return false;
  const sentAt = deps.now();
  const result = await deps.start({
    userId: actor.userId,
    projectId: project.id,
    title,
    prompt,
    model,
    source: SOURCE,
    ...(standing.key && { branch: await deps.branchFor(project.id, standing.key, title) }),
    onCreated: async (workspaceId) => {
      // Not the stage: a stop since stays a stop.
      await deps.setRowWorkspace(installation.id, issueId, workspaceId);
      if (item) await deps.linkItem(scope.orgId, item.id, { workspaceId, projectId: project.id });
      if ((await deps.row(installation.id, issueId))?.stage === "stopped") return;
      // Watched from here, so a setup that outlasts this process still has its end told.
      await deps.openWatch(installation.id, issueId, { sentAt, baselineActivity: null });
      await deps.comment(installation.id, issueId, `Session started: [open it in Outrunner](${deps.sessionUrl(workspaceId)})`).catch((error: unknown) => console.warn("Jira: couldn't say a session started", error));
      await deps.remoteLink(installation.id, issueId, deps.sessionUrl(workspaceId), "Outrunner session").catch((error: unknown) => console.warn("Jira: couldn't link the session", error));
      await moveToStarted(context, scope, standing);
    },
  });

  // Unassigned during its setup, its prompt went out regardless: it stops now.
  const stoppedSince = (await deps.row(installation.id, issueId))?.stage === "stopped";
  if (result.status === "ready") {
    if (!stoppedSince) return !(standing.open && (await closedSince(context, scope, item, actor.userId, result.workspaceId)));
    await deps.stop(actor.userId, result.workspaceId).catch((error: unknown) => console.warn("Jira: couldn't interrupt a session stopped during setup", error));
    return false;
  }
  if (stoppedSince) return false;
  const reason = result.errorMessage ?? "Its setup failed.";
  await deps.stopRow(installation.id, issueId);
  await moveIssue(context, scope, standing, blockedTarget, "blocked");
  await deps.comment(installation.id, issueId, result.workspaceId ? `The session couldn't start: ${reason}\n\n${deps.sessionUrl(result.workspaceId)}` : `The session couldn't start: ${reason}`);
  if (item) {
    await deps.addNote(scope.orgId, item.id, {
      authorId: null,
      body: `The session couldn't start: ${reason}`,
      source: SOURCE,
      sourceUrl: url,
      author: "Jira",
      sourceRef: `${SOURCE}:${issueId}:failed:${result.workspaceId ?? "none"}`,
    });
  }
  return false;
}

/** The project's status for work started, from not started yet or from Blocked. A workflow
 *  may offer no way there, and then it stays. */
function moveToStarted(context: Context, scope: TrackerScope, standing: JiraIssueStanding): Promise<void> {
  return moveIssue(context, scope, standing, startedTarget, "started");
}

/** Move the issue as `target` says, from where it was when this began (lib/trackers/rules.ts).
 *  Best effort: the work goes on whether or not Jira moves. */
async function moveIssue(
  { installation, deps, issueId }: Context,
  scope: TrackerScope,
  standing: JiraIssueStanding,
  target: (map: TrackerScope["stateMap"], issue: IssueState) => string | null,
  what: string,
): Promise<void> {
  const status = target(scope.stateMap, standing);
  if (!status) return;
  try {
    if (!(await deps.transition(installation.id, issueId, status))) console.warn(`Jira: no transition to status ${status} from where issue ${issueId} is`);
  } catch (error) {
    console.warn(`Jira: couldn't move an issue to ${what}`, error);
  }
}
