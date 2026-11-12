/**
 * What a Linear webhook does in Outrunner (docs/linear-app.md), once
 * app/api/integrations/linear/webhook has checked its signature and timestamp:
 *
 *   revoked   the app may have been uninstalled there: disconnected if the
 *             install's token has really stopped working
 *   Issue     rules file it to triage; the item then follows the issue's
 *             title, description and open/closed, until it moves out of reach
 *   Comment   a note on the issue's item, edited and deleted with it
 *
 * The tracker owns the title, the description and open/closed; Outrunner owns
 * the triage decision, the project and the session. So an item someone declined
 * here stays declined when the issue closes there, and a later comment there
 * doesn't undo it.
 *
 * Handled before the webhook answers: this is a few database writes, and a
 * failure has to answer non-200 for Linear to deliver it again. An event is
 * marked seen only once it's done, so a crash part way loses nothing, and every
 * step can run again: notes and items have unique refs, a close only moves an
 * open item, and where a note and a change go together, the note goes first.
 * Waking a session to archive it takes minutes, so that goes after the answer
 * (`defer`).
 */

import { filingActor } from "@/lib/trackers/filing";
import { isOwnLinearEvent } from "@/lib/trackers/linear";
import type { AgentPayload } from "@/lib/trackers/linear-agent";
import { firstMatch, isClosedStateType, type IssueFacts, type TrackerRule } from "@/lib/trackers/rules";
import { archiveClosedSession, type ArchiveClosedDeps, type ClosedSession } from "@/lib/session/archive-closed";
import { canSee, type TriageActor } from "@/lib/triage/access";
import { cutText, isOpen, MAX_BODY, MAX_TITLE, type WorkItem } from "@/lib/triage/work-items";
import type { TrackerFiling, TrackerNote } from "@/lib/db/work-items";
import type { TrackerInstallation, TrackerScope } from "@/lib/db/trackers";

const SOURCE = "linear" as const;
/** What re-checks the rules: a change to anything they filter on, or a move. */
const RULE_FIELDS = ["labelIds", "stateId", "priority", "assigneeId", "teamId"] as const;

export type LinearEventDeps = ArchiveClosedDeps & {
  installation(externalId: string): Promise<TrackerInstallation | null>;
  /** Whether the install's token still answers Linear. False once it's been
   *  disconnected: a refused refresh does that on the way. */
  appTokenWorks(installationId: string): Promise<boolean>;
  eventSeen(eventId: string): Promise<boolean>;
  /** Whether this was the first to mark it. */
  markEventSeen(eventId: string): Promise<boolean>;
  scopeForTeam(installationId: string, teamId: string): Promise<TrackerScope | null>;
  rulesForScope(scopeId: string): Promise<TrackerRule[]>;
  orgIds(installationId: string): Promise<string[]>;
  linkedOwner(installationId: string, externalUserId: string): Promise<string | null>;
  triageActor(userId: string, orgId: string): Promise<TriageActor | null>;
  item(orgId: string, sourceRef: string): Promise<WorkItem | null>;
  itemsInOrgs(orgIds: readonly string[], sourceRef: string): Promise<{ orgId: string; item: WorkItem }[]>;
  itemById(orgId: string, id: string): Promise<WorkItem | null>;
  file(actor: TriageActor, filing: TrackerFiling, installationId: string): Promise<WorkItem | null>;
  /** An agent session's event: lib/trackers/linear-agent.ts. What it does after the answer
   *  goes through `later`, to wait for the event being marked seen. */
  agentEvent(installation: TrackerInstallation, payload: AgentPayload, later: (work: () => Promise<unknown>) => void): Promise<LinearEventResult>;
  /** Delegated again: Linear sends no agent event for that. Run after it's marked seen. */
  redelegated(installation: TrackerInstallation, again: { issueId: string; actorId: string | null; actorName: string | null; at: number | null; issue: { id: string; identifier: unknown; teamId: string; title: string; description: string; url: string | null } }): Promise<unknown>;
  /** Un-delegated: stop any turn, and send nothing more. How many were working. */
  /** How many turns stopping it would stop. */
  workingTurns(installationId: string, issueId: string): Promise<number>;
  stopDelegation(installationId: string, issueId: string): Promise<unknown>;
  followText(orgId: string, id: string, text: { title?: string; body?: string }): Promise<void>;
  close(orgId: string, item: WorkItem, close: { status: "done" | "declined" } | { status: "duplicate"; duplicateOf: string }): Promise<void>;
  reopen(orgId: string, id: string): Promise<WorkItem>;
  stopFollowing(orgId: string, id: string): Promise<void>;
  addNote(orgId: string, itemId: string, note: TrackerNote): Promise<void>;
  /** The comment's own note, in any org: what's taken back leaves wherever it went. */
  editNote(sourceRef: string, body: string): Promise<void>;
  deleteNote(sourceRef: string): Promise<void>;
  /** What a delegation kept of a comment that's been edited or deleted. */
  forgetComment(commentId: string): Promise<void>;
  /** Questions for Linear. A disconnected install answers null. */
  issueStanding(installationId: string, issueId: string): Promise<{ teamId: string; open: boolean; stateType: string | null } | null>;
  issueCreator(installationId: string, issueId: string): Promise<{ id: string; name: string | null } | null>;
  duplicateOf(installationId: string, issueId: string): Promise<string | null>;
  session(workspaceId: string): Promise<ClosedSession | null>;
  archiveOnClose(orgId: string): Promise<boolean>;
  /** The issue taken back or closed: its Missions' requests cancelled, and
   *  only those (lib/missions/linear-route.ts). Absent: none. */
  missionIssueEnded?(installationId: string, issueId: string, reason: string): Promise<void>;
  /** Run after the webhook has answered. */
  defer(work: () => Promise<unknown>): void;
};

export type LinearEventInput = {
  /** The Linear-Delivery header. */
  deliveryId: string | null;
  payload: unknown;
};

export type LinearEventResult = { handled: boolean; reason?: string };

const ignored = (reason: string): LinearEventResult => ({ handled: false, reason });

type Payload = {
  createdAt?: unknown;
  action?: unknown;
  type?: unknown;
  organizationId?: unknown;
  oauthClientId?: unknown;
  userId?: unknown;
  actor?: { id?: unknown; name?: unknown; type?: unknown } | null;
  data?: Record<string, unknown> | null;
  url?: unknown;
  updatedFrom?: Record<string, unknown> | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function issueRef(issueId: string): string {
  return `${SOURCE}:${issueId}`;
}

function commentRef(commentId: string): string {
  return `${SOURCE}:comment:${commentId}`;
}

/** A name as it's kept: plain, as the item's source already says Linear. */
function authorName(name: string | null): string | null {
  return name ? cutText(name, 200) : null;
}

export async function handleLinearEvent(input: LinearEventInput, deps: LinearEventDeps): Promise<LinearEventResult> {
  if (typeof input.payload !== "object" || input.payload === null) return ignored("not an object");
  const payload = input.payload as Payload;
  const externalId = text(payload.organizationId);
  if (!externalId) {
    // Signed, so it's Linear's: if its events stopped saying this, every issue
    // would be ignored with a 200 and nothing would look wrong.
    console.warn("Linear: a signed event had no organization, so it was ignored");
    return ignored("no organization");
  }
  const installation = await deps.installation(externalId);
  if (!installation || installation.disconnected) return ignored("not installed");

  // Someone's authorization was revoked. The signature already says it's about our
  // app: each app signs with its own secret, and oauthClientId is Linear's id for
  // the app, not its client_id. A person's says so in userId, and every link revokes
  // one, so it's no news. For the app's, the install's token decides, as a late one
  // may arrive after a reconnect: asking goes the usual way (lib/trackers/tokens.ts),
  // so a refused refresh is what disconnects, and Linear being down throws, for this
  // event to be delivered again.
  if (payload.action === "revoked" && payload.oauthClientId !== undefined) {
    const revokedUser = text(payload.userId);
    if (revokedUser && revokedUser !== installation.appUserId) return ignored("a person's");
    if (await deps.appTokenWorks(installation.id)) {
      console.warn("Linear: an app revocation arrived, but the install's token still works, so it stays connected");
      return ignored("token still works");
    }
    return { handled: true };
  }

  // Before dedupe: what we wrote there must never come back and reopen an item.
  if (isOwnLinearEvent(payload, installation.appUserId)) return ignored("our own");

  if (!input.deliveryId) return ignored("no delivery id");
  const eventId = `${SOURCE}:${input.deliveryId}`;
  if (await deps.eventSeen(eventId)) return ignored("already handled");
  // A throw leaves it unseen, for the redelivery to finish.
  const afterSeen: (() => Promise<unknown>)[] = [];
  const result =
    payload.type === "Issue"
      ? await handleIssue(installation, payload, eventId, deps, (work) => void afterSeen.push(work))
      : payload.type === "AgentSessionEvent"
        ? await deps.agentEvent(installation, payload as AgentPayload, (work) => void afterSeen.push(work))
        : payload.type === "Comment"
        ? await handleComment(installation, payload, deps)
        : ignored("not an issue or comment");
  // Marked first: if that fails, the redelivery finds nothing started by the first. Of two
  // copies at once, only whichever marked it first acts.
  if (await deps.markEventSeen(eventId)) for (const work of afterSeen) deps.defer(work);
  return result;
}

// --- Issues -----------------------------------------------------------------

type Issue = {
  id: string;
  teamId: string;
  title: string;
  body: string;
  url: string | null;
  completed: boolean;
  closed: boolean;
  trashed: boolean;
  facts: IssueFacts;
  creatorId: string | null;
  creatorName: string | null;
};

function readIssue(payload: Payload): Issue | null {
  const data = payload.data;
  if (!data) return null;
  const id = text(data.id);
  const team = data.team as { id?: unknown } | null | undefined;
  const teamId = text(data.teamId) ?? text(team?.id);
  if (!id || !teamId) return null;
  const state = data.state as { type?: unknown } | null | undefined;
  const creator = data.creator as { name?: unknown } | null | undefined;
  const actorName = payload.action === "create" ? text(payload.actor?.name) : null;
  return {
    id,
    teamId,
    title: cutText((text(data.title) ?? "Untitled issue").replace(/\s+/g, " "), MAX_TITLE),
    body: cutText(text(data.description) ?? "", MAX_BODY),
    url: text(data.url) ?? text(payload.url),
    completed: state?.type === "completed",
    closed: isClosedStateType(state?.type),
    trashed: data.trashed === true,
    facts: {
      labels: Array.isArray(data.labelIds) ? data.labelIds.filter((l): l is string => typeof l === "string") : [],
      state: text(data.stateId),
      priority: typeof data.priority === "number" ? String(data.priority) : null,
      // Linear has no issue types.
      issueType: null,
      assignee: text(data.assigneeId),
    },
    creatorId: text(data.creatorId) ?? text(payload.action === "create" ? payload.actor?.id : null),
    creatorName: text(creator?.name) ?? actorName,
  };
}

/** A note Outrunner itself adds on the issue's behalf. Once per event. */
function systemNote(eventId: string, kind: string, body: string, url: string | null): TrackerNote {
  return { authorId: null, body, source: SOURCE, sourceUrl: url, author: "Linear", sourceRef: `${eventId}:${kind}` };
}

async function handleIssue(installation: TrackerInstallation, payload: Payload, eventId: string, deps: LinearEventDeps, later: (work: () => Promise<unknown>) => void): Promise<LinearEventResult> {
  const issue = readIssue(payload);
  if (!issue) return ignored("no issue");
  const ref = issueRef(issue.id);
  const from = payload.updatedFrom ?? {};
  const app = installation.appUserId;
  const delegate = payload.data?.delegateId;

  const scope = await deps.scopeForTeam(installation.id, issue.teamId);

  // Whether or not there's an item yet: a question waiting on someone has none, and its
  // answer shouldn't start anything once it's been taken back. The note first: it's once per
  // event, so a retry after a failed stop only stops it, where one after a stop would find
  // nothing left to say.
  if (from.delegateId === app && delegate !== app) {
    if ((await deps.workingTurns(installation.id, issue.id)) > 0) {
      const held = scope ? await deps.item(scope.orgId, ref) : null;
      if (scope && held) await deps.addNote(scope.orgId, held.id, systemNote(eventId, "undelegated", "Outrunner was un-delegated in Linear, so its turn stopped. The session stays.", issue.url));
    }
    await deps.stopDelegation(installation.id, issue.id);
    await deps.missionIssueEnded?.(installation.id, issue.id, "taken back in Linear");
  }
  // Closed just now: a Mission's request for it is done with.
  if (issue.closed && "stateId" in from && !(Boolean(from.completedAt) || Boolean(from.canceledAt))) {
    await deps.missionIssueEnded?.(installation.id, issue.id, "the issue closed in Linear");
  }
  if (app && delegate === app && "delegateId" in from && from.delegateId !== app) {
    const again = {
      issueId: issue.id,
      // Only a person is one: a rule or an integration takes the rule's path.
      actorId: payload.actor?.type === "user" ? text(payload.actor.id) : null,
      actorName: payload.actor?.type === "user" ? text(payload.actor.name) : null,
      // Linear's clock, and the same on a retry.
      at: Number.isFinite(Date.parse(text(payload.createdAt) ?? "")) ? Date.parse(text(payload.createdAt) as string) : null,
      issue: { id: issue.id, identifier: payload.data?.identifier, teamId: issue.teamId, title: issue.title, description: issue.body, url: issue.url },
    };
    later(() => deps.redelegated(installation, again));
  }

  // Moved: an item stays in its org, and stops following an issue that left it.
  const fromTeam = text(from.teamId);
  if (fromTeam && fromTeam !== issue.teamId) {
    const previous = await deps.scopeForTeam(installation.id, fromTeam);
    if (previous && previous.orgId !== scope?.orgId) {
      const left = await deps.item(previous.orgId, ref);
      if (left) {
        const where = scope ? "a team in another Outrunner org" : "a Linear team not connected to Outrunner";
        await deps.addNote(previous.orgId, left.id, systemNote(eventId, "moved", `The issue moved to ${where}, so this item no longer follows it.`, issue.url));
        await deps.stopFollowing(previous.orgId, left.id);
      }
    }
  }
  if (!scope) return ignored("team not connected");

  const item = await deps.item(scope.orgId, ref);
  if (item) {
    await followIssue(installation, payload, issue, item, scope, eventId, deps);
    return { handled: true };
  }

  // Not held: only a new issue, or a change to what rules filter on, is news.
  if (payload.action === "remove" || issue.trashed || issue.closed) return ignored("closed");
  const recheck = payload.action === "create" || RULE_FIELDS.some((field) => field in from);
  if (!recheck) return ignored("nothing rules look at");
  const rule = firstMatch(await deps.rulesForScope(scope.id), issue.facts);
  if (!rule) return ignored("no rule matches");
  const author = await issueAuthor(installation, issue, deps);
  const actor = await filingActor(installation.id, rule, author.id, scope.orgId, deps);
  if (!actor) {
    console.warn(`Linear: rule ${rule.id} has stopped: whoever set it has left or can't file there`);
    return ignored("rule stopped");
  }
  await deps.file(actor, {
    title: issue.title,
    body: issue.body,
    projectId: rule.projectId,
    source: SOURCE,
    sourceUrl: issue.url,
    sourceRef: ref,
    sourceAuthor: authorName(author.name),
  }, installation.id);
  return { handled: true };
}

/**
 * Who wrote the issue. An issue filed when a label is added later has only that
 * change's actor on its event, who isn't its author, so Linear is asked. Not
 * worth failing the filing over: the item just doesn't name them.
 */
async function issueAuthor(installation: TrackerInstallation, issue: Issue, deps: LinearEventDeps): Promise<{ id: string | null; name: string | null }> {
  if (issue.creatorName) return { id: issue.creatorId, name: issue.creatorName };
  const creator = await deps.issueCreator(installation.id, issue.id).catch((error: unknown) => {
    console.warn("Linear: couldn't look up an issue's creator", error);
    return null;
  });
  return { id: issue.creatorId ?? creator?.id ?? null, name: creator?.name ?? null };
}

/**
 * An issue we hold: the item follows its title, description and open/closed.
 * Each close acts on the change to closed, not on the issue being closed, so an
 * edit to a closed issue doesn't archive a session someone restored. Only moving
 * the item depends on it being open; its session is handled either way: a merged
 * PR may have made it done before Linear closed the issue, and someone may have
 * declined it here first.
 */
async function followIssue(
  installation: TrackerInstallation,
  payload: Payload,
  issue: Issue,
  item: WorkItem,
  scope: TrackerScope,
  eventId: string,
  deps: LinearEventDeps,
): Promise<void> {
  const from = payload.updatedFrom ?? {};
  const orgId = scope.orgId;

  // Linear sends `remove` for the trash and for archiving, and only the trash sets
  // `trashed`. Archiving hides an issue, which says nothing about the work, so an
  // open item stays, saying why its link now leads nowhere. Not a closed one: Linear
  // archives long-closed issues by itself, and those notes would only be clutter.
  if (payload.action === "remove") {
    if (!issue.trashed) {
      if (isOpen(item.status)) {
        await deps.addNote(orgId, item.id, systemNote(eventId, "archived", "The issue was archived or deleted in Linear. This item stays open.", issue.url));
      }
      return;
    }
    if (isOpen(item.status)) {
      await deps.addNote(orgId, item.id, systemNote(eventId, "deleted", "The issue was deleted in Linear.", issue.url));
      await deps.close(orgId, item, { status: "declined" });
    }
    await sessionOnClose(item, orgId, issue, eventId, deps);
    return;
  }
  if (issue.trashed) return;

  const changed: { title?: string; body?: string } = {};
  if ("title" in from && issue.title !== item.title) changed.title = issue.title;
  if ("description" in from && issue.body !== item.body) changed.body = issue.body;
  if (changed.title !== undefined || changed.body !== undefined) await deps.followText(orgId, item.id, changed);

  // The note above would otherwise go stale.
  if (payload.action === "restore" && isOpen(item.status)) {
    await deps.addNote(orgId, item.id, systemNote(eventId, "restored", "The issue is back in Linear.", issue.url));
    return;
  }

  // What it was before this change: Done → Canceled changes the state but is no
  // new close, and a closed issue moved to another team takes a state there.
  const wasClosed = Boolean(from.completedAt) || Boolean(from.canceledAt);
  if (issue.closed) {
    if (!("stateId" in from) || wasClosed || "teamId" in from) return;
    // A redelivery may find it a duplicate already, with the rest of that still to finish.
    if (isOpen(item.status) || item.status === "duplicate") {
      const how = await closure(installation, issue, orgId, deps);
      if (isOpen(item.status) || how.status === "duplicate") await deps.close(orgId, item, how);
    }
    await sessionOnClose(item, orgId, issue, eventId, deps);
    return;
  }

  // Back open there, or back from the trash or an archive (`restore`, which doesn't
  // say which): so is the item, unless the issue is itself closed.
  if ((wasClosed || payload.action === "restore") && !isOpen(item.status)) {
    await deps.addNote(orgId, item.id, systemNote(eventId, "reopened", "The issue was reopened in Linear.", issue.url));
    await deps.reopen(orgId, item.id);
  }
}

/** Done for a finished issue; for a duplicate or canceled one, a duplicate when it names an
 *  original we hold open, declined otherwise. */
async function closure(
  installation: TrackerInstallation,
  issue: Issue,
  orgId: string,
  deps: LinearEventDeps,
): Promise<{ status: "done" | "declined" } | { status: "duplicate"; duplicateOf: string }> {
  if (issue.completed) return { status: "done" };
  const originalId = await deps.duplicateOf(installation.id, issue.id);
  if (originalId) {
    const original = await deps.item(orgId, issueRef(originalId));
    if (original && isOpen(original.status)) return { status: "duplicate", duplicateOf: original.id };
  }
  return { status: "declined" };
}

/** What closing does to the item's session: archived while the org says so, as
 *  for a GitHub issue, and otherwise left, with a note. */
async function sessionOnClose(item: WorkItem, orgId: string, issue: Issue, eventId: string, deps: LinearEventDeps): Promise<void> {
  if (!item.workspaceId) return;
  const session = await deps.session(item.workspaceId);
  if (!session || session.status === "archived") return;
  if (!(await deps.archiveOnClose(orgId))) {
    await deps.addNote(orgId, item.id, systemNote(eventId, "session", "The issue closed. Its session stays, as this org doesn't archive sessions on close.", issue.url));
    return;
  }
  deps.defer(async () => {
    // Mid another step, or it couldn't be woken: nothing else would say why it's still there.
    if ((await archiveClosedSession(session, "Linear", `issue ${issue.id}`, deps)) === 0) {
      await deps.addNote(orgId, item.id, systemNote(eventId, "session", "The issue closed, but its session couldn't be archived just then. It stays.", issue.url));
    }
  });
}

// --- Comments ---------------------------------------------------------------

async function handleComment(installation: TrackerInstallation, payload: Payload, deps: LinearEventDeps): Promise<LinearEventResult> {
  const data = payload.data;
  const commentId = text(data?.id);
  if (!data || !commentId) return ignored("no comment");
  const ref = commentRef(commentId);
  const orgIds = await deps.orgIds(installation.id);

  // An edit or a delete reaches its note even on an item that no longer follows
  // the issue, whose team was disconnected, or whose org has left this workspace: what's
  // being taken back (a pasted secret) leaves wherever it went. The event is signed and
  // the ref is that comment's own. Neither ever starts anything.
  if (payload.action === "remove") {
    await deps.deleteNote(ref);
    await deps.forgetComment(commentId);
    return { handled: true };
  }
  const body = cutText(text(data.body) ?? "", MAX_BODY);
  if (payload.action === "update") {
    // Edited down to an image or an emoji, what it said still goes: it may be a pasted secret.
    await deps.editNote(ref, body || "Edited in Linear to something with no text.");
    await deps.forgetComment(commentId);
    return { handled: true };
  }
  if (payload.action !== "create") return ignored("not a change");
  if (!body) return ignored("empty");

  const issueId = text(data.issueId);
  if (!issueId) return ignored("not on an issue");
  const held = await deps.itemsInOrgs(orgIds, issueRef(issueId));
  if (held.length === 0) return ignored("issue not held");

  // A comment's event doesn't say the issue's team or state. An item's team can
  // be disconnected with nothing marking its items, so Linear is asked: only for
  // an issue we hold, and it's one call.
  const standing = await deps.issueStanding(installation.id, issueId);
  if (!standing) return ignored("issue not found");
  const scope = await deps.scopeForTeam(installation.id, standing.teamId);
  const found = held.find((h) => h.orgId === scope?.orgId);
  if (!found) return ignored("team not connected");
  const { orgId, item } = found;

  const user = data.user as { name?: unknown } | null | undefined;
  const commenterId = text(data.userId);
  const owner = commenterId ? await deps.linkedOwner(installation.id, commenterId) : null;
  const commenter = owner ? await deps.triageActor(owner, orgId) : null;
  const note: TrackerNote = {
    // A member only if it's really theirs; `author` says who wrote it regardless.
    authorId: commenter && canSee(commenter, item) ? commenter.userId : null,
    body,
    source: SOURCE,
    sourceUrl: text(data.url) ?? text(payload.url),
    author: authorName(text(user?.name) ?? text(payload.actor?.name)) ?? "Linear",
    sourceRef: ref,
  };

  // A duplicate's comments go on to what it duplicates while that's open.
  const original = item.status === "duplicate" && item.duplicateOf ? await deps.itemById(orgId, item.duplicateOf) : null;
  if (original && isOpen(original.status)) {
    await deps.addNote(orgId, original.id, note);
    return { handled: true };
  }
  // Note first, so a redelivery after a failed reopen still has it. Only a done
  // item reopens, while the issue is open: declined and duplicate are decisions
  // made here, which a comment there doesn't undo.
  await deps.addNote(orgId, item.id, note);
  if (item.status === "done" && standing.open) await deps.reopen(orgId, item.id);
  return { handled: true };
}
