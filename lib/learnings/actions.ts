/**
 * What can be done with learnings (lib/learnings/rules.ts), the one way
 * every caller does it: the settings routes, the public API and its MCP
 * tools, and a session's agent suggesting one (lib/session-tools). Each
 * checks what the actor may do with each learning, so no caller can reach
 * past it. The database is given (lib/db/learnings.ts), so tests run
 * these on a store of their own.
 */

import {
  type Learning,
  type LearningActor,
  type LearningScope,
  type LearningStatus,
  learningRights,
  MAX_LEARNINGS,
  MAX_PENDING_SUGGESTIONS,
  newLearningStatus,
} from "@/lib/learnings/rules";

export type NewLearningRow = {
  orgId: string | null;
  userId: string | null;
  title: string;
  body: string;
  status: LearningStatus;
  createdBy: string;
  suggestedIn: string | null;
};

export type LearningStore = {
  /** A scope's learnings, oldest first: an org's (`orgId`) or a person's (`userId`). */
  list(where: { orgId: string } | { userId: string }): Promise<Learning[]>;
  get(id: string): Promise<Learning | null>;
  insert(row: NewLearningRow): Promise<Learning>;
  update(id: string, patch: { title?: string; body?: string; status?: LearningStatus }): Promise<Learning | null>;
  remove(id: string): Promise<boolean>;
};

/** What an org's audit log records of its learnings. */
export type LearningAuditAction = "learning.created" | "learning.suggested" | "learning.changed" | "learning.accepted" | "learning.deleted";

export type LearningDeps = {
  store: LearningStore;
  /** Record a change to an org's learning; a person's own aren't audited. */
  audit?(action: LearningAuditAction, learning: Learning): Promise<void>;
  /** Whether an org is a person's own: it has no learnings of its own, as
   *  its person's are already in every session of theirs. */
  personalOrg?(orgId: string): Promise<boolean>;
};

/** Why a learning couldn't be read or changed, said as the routes answer. */
export class LearningError extends Error {
  readonly status: 400 | 403 | 404 | 409;

  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "LearningError";
    this.status = status;
  }
}

const NOT_FOUND = "No learning by that id that you can see.";

function scopeOf(actor: LearningActor, scope: LearningScope): { orgId: string } | { userId: string } {
  return scope === "org" ? { orgId: actor.orgId } : { userId: actor.userId };
}

/** The learnings the actor may read, of a scope or both, active or
 *  suggested or both: the org's first, then their own, each oldest first. */
export async function listLearnings(
  actor: LearningActor,
  deps: LearningDeps,
  { scope, status }: { scope?: LearningScope; status?: LearningStatus } = {},
): Promise<Learning[]> {
  const scopes: LearningScope[] = scope ? [scope] : ["org", "personal"];
  const lists = await Promise.all(scopes.map((s) => deps.store.list(scopeOf(actor, s))));
  return lists.flat().filter((l) => learningRights(actor, l).read && (!status || l.status === status));
}

/** One learning the actor may read. */
export async function getLearning(actor: LearningActor, deps: LearningDeps, id: string): Promise<Learning> {
  const learning = await deps.store.get(id);
  if (!learning || !learningRights(actor, learning).read) throw new LearningError(404, NOT_FOUND);
  return learning;
}

/** Add a learning. In the org, a member's (or any suggestion) waits for an
 *  admin to accept it; a person's own is theirs at once unless suggested. */
export async function createLearning(
  actor: LearningActor,
  deps: LearningDeps,
  input: { scope: LearningScope; title: string; body: string; suggested?: boolean; suggestedIn?: string | null },
): Promise<Learning> {
  if (input.scope === "org" && (await deps.personalOrg?.(actor.orgId))) {
    throw new LearningError(400, "A personal org has only your own learnings: add it with scope personal.");
  }
  const existing = await deps.store.list(scopeOf(actor, input.scope));
  const status = newLearningStatus(actor, input.scope, input.suggested ?? false);
  if (status === "active" && existing.filter((l) => l.status === "active").length >= MAX_LEARNINGS) {
    throw new LearningError(
      409,
      `${input.scope === "org" ? "The org has" : "You have"} ${MAX_LEARNINGS} learnings, the most there can be. Delete one first.`,
    );
  }
  if (status === "suggested" && existing.filter((l) => l.status === "suggested" && l.createdBy === actor.userId).length >= MAX_PENDING_SUGGESTIONS) {
    throw new LearningError(
      409,
      `${MAX_PENDING_SUGGESTIONS} suggestions of yours are already waiting${input.scope === "org" ? " for the org's admins" : ""}. Accept or dismiss some in Settings → Learnings first.`,
    );
  }
  const learning = await deps.store.insert({
    orgId: input.scope === "org" ? actor.orgId : null,
    userId: input.scope === "personal" ? actor.userId : null,
    title: input.title,
    body: input.body,
    status,
    createdBy: actor.userId,
    suggestedIn: input.suggestedIn ?? null,
  });
  if (learning.scope === "org") await deps.audit?.(status === "active" ? "learning.created" : "learning.suggested", learning);
  return learning;
}

/** Change a learning's text, or accept a suggestion (status `active`). */
export async function updateLearning(
  actor: LearningActor,
  deps: LearningDeps,
  id: string,
  patch: { title?: string; body?: string; status?: LearningStatus },
): Promise<Learning> {
  const learning = await getLearning(actor, deps, id);
  if (!learningRights(actor, learning).write) {
    throw new LearningError(403, "Only the org's admins change its learnings.");
  }
  if (patch.status === "suggested" && learning.status === "active") {
    throw new LearningError(400, "An accepted learning can't go back to being a suggestion. Delete it instead.");
  }
  const accepting = patch.status === "active" && learning.status === "suggested";
  if (accepting) {
    const active = (await deps.store.list(scopeOf(actor, learning.scope))).filter((l) => l.status === "active");
    if (active.length >= MAX_LEARNINGS) {
      throw new LearningError(409, `There are ${MAX_LEARNINGS} learnings already, the most there can be. Delete one first.`);
    }
  }
  const updated = await deps.store.update(id, patch);
  if (!updated) throw new LearningError(404, NOT_FOUND);
  if (updated.scope === "org") await deps.audit?.(accepting ? "learning.accepted" : "learning.changed", updated);
  return updated;
}

/** Delete a learning, or dismiss a suggestion. */
export async function deleteLearning(actor: LearningActor, deps: LearningDeps, id: string): Promise<void> {
  const learning = await getLearning(actor, deps, id);
  if (!learningRights(actor, learning).write) {
    throw new LearningError(403, "Only the org's admins delete its learnings.");
  }
  if (!(await deps.store.remove(id))) throw new LearningError(404, NOT_FOUND);
  if (learning.scope === "org") await deps.audit?.("learning.deleted", learning);
}

/** The learnings a session of `userId` in `orgId` loads: the org's active
 *  ones and the person's own. */
export async function sessionLearnings(
  store: LearningStore,
  userId: string,
  orgId: string,
): Promise<{ org: Learning[]; personal: Learning[] }> {
  const [org, personal] = await Promise.all([store.list({ orgId }), store.list({ userId })]);
  return {
    org: org.filter((l) => l.status === "active"),
    personal: personal.filter((l) => l.status === "active"),
  };
}
