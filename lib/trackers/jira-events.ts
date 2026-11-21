/**
 * What a Jira webhook does in Outrunner (docs/jira-app.md), once
 * app/api/integrations/jira/webhook has checked its token:
 *
 *   Issue     rules file it to triage; the item then follows the issue's title,
 *             description and open/closed, until it moves out of reach
 *   Comment   a note on the issue's item, edited and deleted with it
 *   Either    assigned to, or @mentioning, Outrunner's account: a session
 *             (lib/trackers/jira-agent.ts)
 *
 * As for Linear (lib/trackers/linear-events.ts): the tracker owns the title, description
 * and open/closed; Outrunner owns the triage decision, the project and the session. An
 * event is marked seen only once it's done, and every step can run again.
 *
 * The payloads here were checked against a real Jira Cloud site on its Free plan (Nov 2026):
 * signed deliveries, issue and comment events, wiki-markup bodies, changelogs, an Automation
 * rule's account and moves between projects. A second account and a service project weren't
 * there to check.
 */

import type { TrackerInstallation, TrackerScope } from "@/lib/db/trackers";
import type { TrackerFiling, TrackerNote } from "@/lib/db/work-items";
import { archiveClosedSession, type ArchiveClosedDeps, type ClosedSession } from "@/lib/session/archive-closed";
import { type FilingDeps, filingActor } from "@/lib/trackers/filing";
import { fromAdf, type JiraIssueStanding, jiraMentions, type JiraTokenSite } from "@/lib/trackers/jira";
import { type JiraActor, jiraIssueRef, jiraIssueUrl, type JiraTrigger } from "@/lib/trackers/jira-agent";
import { firstMatch, type IssueFacts, type TrackerRule } from "@/lib/trackers/rules";
import { canSee, type TriageActor } from "@/lib/triage/access";
import { cutText, isOpen, MAX_BODY, MAX_TITLE, type WorkItem } from "@/lib/triage/work-items";

const SOURCE = "jira" as const;
/** What re-checks the rules: a change to anything they filter on, or a move. */
const RULE_FIELDS = ["labels", "status", "priority", "issuetype", "assignee", "project"] as const;
/** A comment naming a repository, which answers "which repository?". */
const REPO_REPLY = /\brepo=[\w.-]+\/[\w.-]+/i;
/** Resolutions that mean the work wasn't done. Sites name their own: these are the usual. */
const NOT_DONE = /won'?t|declin|cancel|cannot|can't|reject|invalid|obsolete/i;

export type JiraEventResult = { handled: boolean; reason?: string };

export type JiraSiteHint = { cloudId: string | null; host: string | null };

export type JiraEventDeps = ArchiveClosedDeps &
  FilingDeps & {
    installation(hint: JiraSiteHint): Promise<TrackerInstallation | null>;
    eventSeen(eventId: string): Promise<boolean>;
    /** Whether this was the first to mark it. */
    markEventSeen(eventId: string): Promise<boolean>;
    scopeForTeam(installationId: string, projectId: string): Promise<TrackerScope | null>;
    rulesForScope(scopeId: string): Promise<TrackerRule[]>;
    orgIds(installationId: string): Promise<string[]>;
    item(orgId: string, sourceRef: string): Promise<WorkItem | null>;
    itemsInOrgs(orgIds: readonly string[], sourceRef: string): Promise<{ orgId: string; item: WorkItem }[]>;
    itemById(orgId: string, id: string): Promise<WorkItem | null>;
    file(actor: TriageActor, filing: TrackerFiling, installationId: string): Promise<WorkItem | null>;
    followText(orgId: string, id: string, text: { title?: string; body?: string }): Promise<void>;
    close(orgId: string, item: WorkItem, close: { status: "done" | "declined" } | { status: "duplicate"; duplicateOf: string }): Promise<void>;
    reopen(orgId: string, id: string): Promise<WorkItem>;
    stopFollowing(orgId: string, id: string): Promise<void>;
    addNote(orgId: string, itemId: string, note: TrackerNote): Promise<void>;
    /** The comment's own note, in any org: what's taken back leaves wherever it went. */
  editNote(sourceRef: string, body: string): Promise<void>;
    deleteNote(sourceRef: string): Promise<void>;
    /** What's kept of a comment that's been edited or deleted, for a question waiting. */
    forgetComment(installationId: string, commentId: string): Promise<void>;
    /** Questions for Jira. A disconnected install answers null. */
    issueStanding(installationId: string, issueId: string): Promise<JiraIssueStanding | null>;
    statusType(installationId: string, statusId: string): Promise<string | null>;
    session(workspaceId: string): Promise<ClosedSession | null>;
    archiveOnClose(orgId: string): Promise<boolean>;
    /** Assigned or @mentioned. Runs after the answer, and after the event's marked seen: a
     *  retry must not ask for it again. */
    trigger(installation: TrackerInstallation, trigger: JiraTrigger): void;
    /** Un-assigned: stop any turn, and send nothing more. How many were working. */
    /** How many turns stopping it would stop. */
    workingTurns(installationId: string, issueId: string): Promise<number>;
    stopDelegation(installationId: string, issueId: string): Promise<unknown>;
    /** Run after the webhook has answered. */
    defer(work: () => Promise<unknown>): void;
  };

export type JiraEventInput = {
  /** The X-Atlassian-Webhook-Identifier header: the same across retries. */
  identifier: string | null;
  payload: unknown;
  /** The site (cloud id) its verified token was issued for, and which claim said so
   *  (jiraTokenSite). */
  site: JiraTokenSite;
};

const ignored = (reason: string): JiraEventResult => ({ handled: false, reason });

type User = { accountId?: unknown; accountType?: unknown; displayName?: unknown } | null | undefined;
type ChangeItem = { field?: unknown; fieldId?: unknown; from?: unknown; to?: unknown; fromString?: unknown; toString?: unknown };
type IssuePayload = { id?: unknown; key?: unknown; self?: unknown; fields?: Record<string, unknown> | null };
type Payload = {
  webhookEvent?: unknown;
  user?: User;
  issue?: IssuePayload | null;
  comment?: { id?: unknown; self?: unknown; body?: unknown; updated?: unknown; author?: User; updateAuthor?: User } | null;
  changelog?: { id?: unknown; items?: unknown } | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Which site an event is about, by its `self` URLs: its payload has no field saying. A
 *  webhook's id is only unique within a site, and is no way to tell one: an event we can't
 *  place is dropped with a warning, rather than given to the wrong org. */
export function siteHint(payload: { issue?: { self?: unknown } | null; comment?: { self?: unknown } | null }): JiraSiteHint {
  for (const self of [payload.issue?.self, payload.comment?.self]) {
    const url = text(self);
    if (!url) continue;
    const cloudId = url.match(/\/ex\/jira\/([^/]+)\//)?.[1];
    if (cloudId) return { cloudId, host: null };
    try {
      return { cloudId: null, host: new URL(url).host };
    } catch {
      continue;
    }
  }
  return { cloudId: null, host: null };
}

function actorOf(user: User): JiraActor {
  const kind = user?.accountType === "atlassian" ? "person" : user?.accountType === "app" ? "rule" : "other";
  return { id: text(user?.accountId), name: text(user?.displayName), kind };
}

/**
 * What makes this event the same one again: the change or comment itself, so a retry, the
 * old and new webhook during a re-register, or a stray one all count once. Only failing
 * those, Jira's own identifier for the delivery, which differs between webhooks.
 */
export function jiraEventKey(cloudId: string, payload: Payload, identifier: string | null): string | null {
  const event = text(payload.webhookEvent);
  const issueId = text(payload.issue?.id);
  const changelog = payload.changelog?.id;
  if (event === "jira:issue_updated" && (typeof changelog === "string" || typeof changelog === "number")) return `${SOURCE}:changelog:${cloudId}/${changelog}`;
  if ((event === "jira:issue_created" || event === "jira:issue_deleted") && issueId) return `${SOURCE}:${event}:${cloudId}/${issueId}`;
  const comment = text(payload.comment?.id);
  if (event?.startsWith("comment_") && comment) return `${SOURCE}:${event}:${cloudId}/${comment}:${text(payload.comment?.updated) ?? ""}`;
  return identifier ? `${SOURCE}:${identifier}` : null;
}

function changesOf(payload: Payload): Map<string, ChangeItem> {
  const items = Array.isArray(payload.changelog?.items) ? (payload.changelog.items as ChangeItem[]) : [];
  return new Map(items.flatMap((item) => {
    const field = text(item.fieldId) ?? text(item.field);
    return field ? [[field, item] as const] : [];
  }));
}

export async function handleJiraEvent(input: JiraEventInput, deps: JiraEventDeps): Promise<JiraEventResult> {
  if (typeof input.payload !== "object" || input.payload === null) return ignored("not an object");
  const payload = input.payload as Payload;
  const installation = await deps.installation(siteHint(payload));
  if (!installation) {
    // Signed, so it's Jira's: if its events stopped saying the site, every issue would be
    // ignored with a 200 and nothing would look wrong.
    console.warn("Jira: a signed event named no site we know, so it was ignored");
    return ignored("not installed");
  }
  if (installation.disconnected) return ignored("not installed");
  // The body says which site; the signed token must say the same one, or a token from one
  // site the app is on could carry an event made up for another's.
  if (installation.externalId !== input.site.site) {
    // Cloud ids aren't secrets: both, and where the token's came from, so a token that names
    // its site some other way than we read it shows as that, not as a forgery.
    console.warn(
      `Jira: a signed event's token is for site ${input.site.site} (from its ${input.site.from} claim; claims: ${input.site.keys.join(", ")}), but its body names ${installation.externalId}, so it was ignored`,
    );
    return ignored("wrong site");
  }

  // Before dedupe: what we wrote there must never come back and reopen an item.
  const author = payload.comment ? (payload.comment.updateAuthor ?? payload.comment.author) : payload.user;
  if (installation.appUserId && text(author?.accountId) === installation.appUserId) return ignored("our own");

  const eventId = jiraEventKey(installation.externalId, payload, input.identifier);
  if (!eventId) return ignored("no identifier");
  if (await deps.eventSeen(eventId)) return ignored("already handled");

  // A throw leaves it unseen, for the retry to finish.
  const triggers: JiraTrigger[] = [];
  const event = payload.webhookEvent;
  const result =
    event === "jira:issue_created" || event === "jira:issue_updated"
      ? await handleIssue(installation, payload, eventId, triggers, deps)
      : event === "jira:issue_deleted"
        ? await handleDeleted(installation, payload, eventId, deps)
        : event === "comment_created" || event === "comment_updated" || event === "comment_deleted"
          ? await handleComment(installation, payload, triggers, deps)
          : ignored("not an issue or comment");
  // Marked first: if that fails, the retry finds nothing asked for yet, rather than a session
  // told twice. Two copies at once are expected, as a webhook's replacement overlaps the old
  // one: only whichever marked it first acts.
  if (await deps.markEventSeen(eventId)) for (const trigger of triggers) deps.trigger(installation, trigger);
  return result;
}

// --- Issues -----------------------------------------------------------------

type Issue = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  url: string | null;
  closed: boolean;
  resolution: string | null;
  facts: IssueFacts;
  creatorId: string | null;
  creatorName: string | null;
};

function readIssue(installation: TrackerInstallation, payload: Payload): Issue | null {
  const issue = payload.issue;
  const fields = issue?.fields;
  const id = text(issue?.id);
  const project = fields?.project as { id?: unknown } | null | undefined;
  const projectId = text(project?.id);
  if (!fields || !id || !projectId) return null;
  const status = fields.status as { id?: unknown; statusCategory?: { key?: unknown } } | null | undefined;
  const priority = fields.priority as { id?: unknown } | null | undefined;
  const issueType = fields.issuetype as { id?: unknown } | null | undefined;
  const assignee = fields.assignee as { accountId?: unknown } | null | undefined;
  const creator = fields.creator as User;
  const resolution = fields.resolution as { name?: unknown } | null | undefined;
  return {
    id,
    projectId,
    title: cutText((text(fields.summary) ?? "Untitled issue").replace(/\s+/g, " "), MAX_TITLE),
    body: cutText(fromAdf(fields.description), MAX_BODY),
    url: jiraIssueUrl(installation, text(issue?.key)),
    closed: status?.statusCategory?.key === "done",
    resolution: text(resolution?.name),
    facts: {
      labels: Array.isArray(fields.labels) ? fields.labels.filter((l): l is string => typeof l === "string") : [],
      state: text(status?.id),
      priority: text(priority?.id),
      issueType: text(issueType?.id),
      assignee: text(assignee?.accountId),
    },
    creatorId: creator?.accountType === "atlassian" ? text(creator.accountId) : null,
    creatorName: creator?.accountType === "atlassian" ? text(creator.displayName) : null,
  };
}

function systemNote(eventId: string, kind: string, body: string, url: string | null): TrackerNote {
  return { authorId: null, body, source: SOURCE, sourceUrl: url, author: "Jira", sourceRef: `${eventId}:${kind}` };
}

async function handleIssue(installation: TrackerInstallation, payload: Payload, eventId: string, triggers: JiraTrigger[], deps: JiraEventDeps): Promise<JiraEventResult> {
  const issue = readIssue(installation, payload);
  if (!issue) return ignored("no issue");
  const ref = jiraIssueRef(installation.externalId, issue.id);
  const changes = changesOf(payload);
  const created = payload.webhookEvent === "jira:issue_created";
  const scope = await deps.scopeForTeam(installation.id, issue.projectId);

  // Whether or not there's an item yet: a question waiting on someone has none, and its answer
  // shouldn't start anything once it's been taken back.
  await unassigned(installation, issue, ref, scope, changes, eventId, deps);

  // Moved: an item stays in its org, and stops following an issue that left it.
  const fromProject = text(changes.get("project")?.from);
  if (fromProject && fromProject !== issue.projectId) {
    const previous = await deps.scopeForTeam(installation.id, fromProject);
    if (previous && previous.orgId !== scope?.orgId) {
      const left = await deps.item(previous.orgId, ref);
      if (left) {
        const where = scope ? "a project in another Outrunner org" : "a Jira project not connected to Outrunner";
        await deps.addNote(previous.orgId, left.id, systemNote(eventId, "moved", `The issue moved to ${where}, so this item no longer follows it.`, issue.url));
        await deps.stopFollowing(previous.orgId, left.id);
      }
    }
  }

  let result: JiraEventResult = ignored("project not connected");
  if (scope) {
    const item = await deps.item(scope.orgId, ref);
    if (item) {
      await followIssue(installation, issue, item, scope, changes, eventId, deps);
      result = { handled: true };
    } else {
      result = await fileByRule(installation, issue, ref, scope, created, changes, deps);
    }
  }

  const trigger = triggerOf(installation, payload, issue, created, changes);
  if (trigger) {
    triggers.push(trigger);
    return { handled: true };
  }
  return result;
}

/** Assigned to Outrunner's account, or its description now @mentions it. */
function triggerOf(installation: TrackerInstallation, payload: Payload, issue: Issue, created: boolean, changes: Map<string, ChangeItem>): JiraTrigger | null {
  const app = installation.appUserId;
  if (!app) return null;
  const actor = actorOf(payload.user);
  const assigned = created ? issue.facts.assignee === app : text(changes.get("assignee")?.to) === app;
  if (assigned) return { kind: "assigned", issueId: issue.id, actor, text: null };
  const description = changes.get("description");
  const mentioned = created
    ? jiraMentions(payload.issue?.fields?.description, app)
    : description !== undefined && jiraMentions(description.toString, app) && !jiraMentions(description.fromString, app);
  return mentioned ? { kind: "mentioned", issueId: issue.id, actor, text: null } : null;
}

/** Assigned away while it works: the turn stops, the session stays, and nothing more goes
 *  to Jira. The item stays in progress. */
async function unassigned(
  installation: TrackerInstallation,
  issue: Issue,
  ref: string,
  scope: TrackerScope | null,
  changes: Map<string, ChangeItem>,
  eventId: string,
  deps: JiraEventDeps,
): Promise<void> {
  const assignee = changes.get("assignee");
  if (!assignee || !installation.appUserId || text(assignee.from) !== installation.appUserId || text(assignee.to) === installation.appUserId) return;
  // The note first: it's once per event, so a retry after a failed stop only stops it, where
  // one after a stop would find nothing left to say.
  if ((await deps.workingTurns(installation.id, issue.id)) > 0) {
    const item = scope ? await deps.item(scope.orgId, ref) : null;
    if (scope && item) await deps.addNote(scope.orgId, item.id, systemNote(eventId, "unassigned", "Outrunner was unassigned in Jira, so its turn stopped. The session stays.", issue.url));
  }
  await deps.stopDelegation(installation.id, issue.id);
}

/** Not held: only a new issue, or a change to what rules filter on, is news. */
async function fileByRule(
  installation: TrackerInstallation,
  issue: Issue,
  ref: string,
  scope: TrackerScope,
  created: boolean,
  changes: Map<string, ChangeItem>,
  deps: JiraEventDeps,
): Promise<JiraEventResult> {
  if (issue.closed) return ignored("closed");
  if (!created && !RULE_FIELDS.some((field) => changes.has(field))) return ignored("nothing rules look at");
  const rule = firstMatch(await deps.rulesForScope(scope.id), issue.facts);
  if (!rule) return ignored("no rule matches");
  // An event names its creator only sometimes, and a change's actor isn't its author.
  const standing = issue.creatorName ? null : await deps.issueStanding(installation.id, issue.id).catch(() => null);
  const authorId = issue.creatorId ?? standing?.creatorId ?? null;
  const actor = await filingActor(installation.id, rule, authorId, scope.orgId, deps);
  if (!actor) {
    console.warn(`Jira: rule ${rule.id} has stopped: whoever set it has left or can't file there`);
    return ignored("rule stopped");
  }
  await deps.file(actor, {
    title: issue.title,
    body: issue.body,
    projectId: rule.projectId,
    source: SOURCE,
    sourceUrl: issue.url,
    sourceRef: ref,
    sourceAuthor: issue.creatorName ?? standing?.creatorName ?? null,
  }, installation.id);
  return { handled: true };
}

/**
 * An issue we hold. Each close acts on the change to closed, not on the issue being closed:
 * a changelog says which status it came from, and Jira is asked what that one is, so Done to
 * Closed is no new close and doesn't archive a session someone restored.
 */
async function followIssue(
  installation: TrackerInstallation,
  issue: Issue,
  item: WorkItem,
  scope: TrackerScope,
  changes: Map<string, ChangeItem>,
  eventId: string,
  deps: JiraEventDeps,
): Promise<void> {
  const orgId = scope.orgId;
  const changed: { title?: string; body?: string } = {};
  if (changes.has("summary") && issue.title !== item.title) changed.title = issue.title;
  if (changes.has("description") && issue.body !== item.body) changed.body = issue.body;
  if (changed.title !== undefined || changed.body !== undefined) await deps.followText(orgId, item.id, changed);

  const status = changes.get("status");
  // A move takes a status in the new project: not a close or a reopen.
  if (!status || changes.has("project")) return;
  const from = text(status.from);
  const wasClosed = from !== null && (await deps.statusType(installation.id, from)) === "completed";
  if (issue.closed === wasClosed) return;

  if (issue.closed) {
    // A redelivery may find it a duplicate already, with the rest of that still to finish.
    if (isOpen(item.status) || item.status === "duplicate") {
      const how = await closure(installation, issue, orgId, deps);
      if (isOpen(item.status) || how.status === "duplicate") await deps.close(orgId, item, how);
    }
    await sessionOnClose(item, orgId, issue, eventId, deps);
    return;
  }
  if (!isOpen(item.status)) {
    await deps.addNote(orgId, item.id, systemNote(eventId, "reopened", "The issue was reopened in Jira.", issue.url));
    await deps.reopen(orgId, item.id);
  }
}

/** Done, unless its resolution says otherwise: a duplicate when it links an original we hold
 *  open, and declined otherwise. */
async function closure(
  installation: TrackerInstallation,
  issue: Issue,
  orgId: string,
  deps: JiraEventDeps,
): Promise<{ status: "done" | "declined" } | { status: "duplicate"; duplicateOf: string }> {
  const resolution = issue.resolution ?? "";
  if (/duplicate/i.test(resolution)) {
    const originalId = (await deps.issueStanding(installation.id, issue.id))?.duplicateOf;
    if (originalId) {
      const original = await deps.item(orgId, jiraIssueRef(installation.externalId, originalId));
      if (original && isOpen(original.status)) return { status: "duplicate", duplicateOf: original.id };
    }
    return { status: "declined" };
  }
  return NOT_DONE.test(resolution) ? { status: "declined" } : { status: "done" };
}

/** Archived while the org says so, as for a GitHub issue, and otherwise left, with a note. */
async function sessionOnClose(item: WorkItem, orgId: string, issue: { id: string; url: string | null }, eventId: string, deps: JiraEventDeps): Promise<void> {
  if (!item.workspaceId) return;
  const session = await deps.session(item.workspaceId);
  if (!session || session.status === "archived") return;
  if (!(await deps.archiveOnClose(orgId))) {
    await deps.addNote(orgId, item.id, systemNote(eventId, "session", "The issue closed. Its session stays, as this org doesn't archive sessions on close.", issue.url));
    return;
  }
  deps.defer(async () => {
    // Mid another step, or it couldn't be woken: nothing else would say why it's still there.
    if ((await archiveClosedSession(session, "Jira", `issue ${issue.id}`, deps)) === 0) {
      await deps.addNote(orgId, item.id, systemNote(eventId, "session", "The issue closed, but its session couldn't be archived just then. It stays.", issue.url));
    }
  });
}

async function handleDeleted(installation: TrackerInstallation, payload: Payload, eventId: string, deps: JiraEventDeps): Promise<JiraEventResult> {
  const issueId = text(payload.issue?.id);
  if (!issueId) return ignored("no issue");
  const held = await deps.itemsInOrgs(await deps.orgIds(installation.id), jiraIssueRef(installation.externalId, issueId));
  if (held.length === 0) return ignored("issue not held");
  // It's gone, so Jira can't be asked: only what the event says tells whose it was.
  const project = payload.issue?.fields?.project as { id?: unknown } | null | undefined;
  const projectId = text(project?.id);
  const scope = projectId ? await deps.scopeForTeam(installation.id, projectId) : null;
  const found = projectId ? held.find((h) => h.orgId === scope?.orgId) : held.length === 1 ? held[0] : undefined;
  if (!found) return ignored("project not connected");
  const { orgId, item } = found;
  const url = jiraIssueUrl(installation, text(payload.issue?.key));
  if (isOpen(item.status)) {
    await deps.addNote(orgId, item.id, systemNote(eventId, "deleted", "The issue was deleted in Jira.", url));
    await deps.close(orgId, item, { status: "declined" });
  }
  await sessionOnClose(item, orgId, { id: issueId, url }, eventId, deps);
  return { handled: true };
}

// --- Comments ---------------------------------------------------------------

async function handleComment(installation: TrackerInstallation, payload: Payload, triggers: JiraTrigger[], deps: JiraEventDeps): Promise<JiraEventResult> {
  const comment = payload.comment;
  const commentId = text(comment?.id);
  const issueId = text(payload.issue?.id);
  if (!comment || !commentId) return ignored("no comment");
  const ref = `${SOURCE}:comment:${installation.externalId}/${commentId}`;
  const orgIds = await deps.orgIds(installation.id);

  // An edit or a delete reaches its note even on an item that no longer follows the issue,
  // whose project was disconnected, or whose org has left this site: what's being taken back
  // (a pasted secret) leaves wherever it went. The token is checked, and the ref is that
  // comment's own, with its site. Neither ever starts anything.
  if (payload.webhookEvent === "comment_deleted") {
    await deps.deleteNote(ref);
    await deps.forgetComment(installation.id, commentId);
    return { handled: true };
  }
  const body = cutText(fromAdf(comment.body), MAX_BODY);
  if (payload.webhookEvent === "comment_updated") {
    // Edited down to an image or an emoji, what it said still goes: it may be a pasted secret.
    await deps.editNote(ref, body || "Edited in Jira to something with no text.");
    await deps.forgetComment(installation.id, commentId);
    return { handled: true };
  }
  if (!body) return ignored("empty");
  if (!issueId) return ignored("not on an issue");

  const noted = await noteComment(installation, payload, issueId, commentId, ref, body, orgIds, deps);
  const actor = actorOf(comment.author);
  if (installation.appUserId && jiraMentions(comment.body, installation.appUserId)) {
    triggers.push({ kind: "mentioned", issueId, actor, text: body, commentId });
    return { handled: true };
  }
  if (REPO_REPLY.test(body)) {
    triggers.push({ kind: "reply", issueId, actor, text: body });
    return { handled: true };
  }
  return noted;
}

async function noteComment(
  installation: TrackerInstallation,
  payload: Payload,
  issueId: string,
  commentId: string,
  ref: string,
  body: string,
  orgIds: readonly string[],
  deps: JiraEventDeps,
): Promise<JiraEventResult> {
  const held = await deps.itemsInOrgs(orgIds, jiraIssueRef(installation.externalId, issueId));
  if (held.length === 0) return ignored("issue not held");

  // A comment's event doesn't reliably say the issue's project or state. An item's project
  // can be disconnected with nothing marking its items, so Jira is asked: only for an issue
  // we hold, and it's one call.
  const standing = await deps.issueStanding(installation.id, issueId);
  if (!standing) return ignored("issue not found");
  const scope = await deps.scopeForTeam(installation.id, standing.teamId);
  const found = held.find((h) => h.orgId === scope?.orgId);
  if (!found) return ignored("project not connected");
  const { orgId, item } = found;

  const actor = actorOf(payload.comment?.author);
  const owner = actor.id ? await deps.linkedOwner(installation.id, actor.id) : null;
  const commenter = owner ? await deps.triageActor(owner, orgId) : null;
  const url = jiraIssueUrl(installation, standing.key);
  const note: TrackerNote = {
    // A member only if it's really theirs; `author` says who wrote it regardless.
    authorId: commenter && canSee(commenter, item) ? commenter.userId : null,
    body,
    source: SOURCE,
    sourceUrl: url ? `${url}?focusedCommentId=${encodeURIComponent(commentId)}` : null,
    author: actor.name ? cutText(actor.name, 200) : "Jira",
    sourceRef: ref,
  };

  // A duplicate's comments go on to what it duplicates while that's open.
  const original = item.status === "duplicate" && item.duplicateOf ? await deps.itemById(orgId, item.duplicateOf) : null;
  if (original && isOpen(original.status)) {
    await deps.addNote(orgId, original.id, note);
    return { handled: true };
  }
  // Note first, so a retry after a failed reopen still has it. Only a done item reopens,
  // while the issue is open: declined and duplicate are decisions made here.
  await deps.addNote(orgId, item.id, note);
  if (item.status === "done" && standing.open) await deps.reopen(orgId, item.id);
  return { handled: true };
}
