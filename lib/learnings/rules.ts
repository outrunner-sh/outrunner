/**
 * Learnings (20261103110000_learnings.sql): short instructions every new
 * session loads, at two scopes. An org's are its members' to read and its
 * admins' to write, and a member's own for the org is a suggestion an admin
 * accepts. A person's are theirs alone, and follow them into every org.
 *
 * Pure: what a learning is, what a caller may do with one, and how one asked
 * for reads. The database is lib/db/learnings.ts; the operations, which
 * every route and tool goes through, lib/learnings/actions.ts.
 */

import type { OrgRole } from "@/lib/orgs/active";

export type LearningScope = "org" | "personal";
export type LearningStatus = "active" | "suggested";

export const LEARNING_SCOPES: readonly LearningScope[] = ["org", "personal"];
export const LEARNING_STATUSES: readonly LearningStatus[] = ["active", "suggested"];

export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 2000;

/** The most learnings a scope holds, suggestions included: each is in every
 *  session's prompt, so a long list costs every turn. */
export const MAX_LEARNINGS = 100;

export type Learning = {
  id: string;
  scope: LearningScope;
  /** The org it's the team's in; null for a person's own. */
  orgId: string | null;
  /** The person it's the own of; null for an org's. */
  userId: string | null;
  title: string;
  body: string;
  status: LearningStatus;
  createdBy: string | null;
  /** The session whose agent suggested it. */
  suggestedIn: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Who is asking, where: the org the call is in, and their role there. */
export type LearningActor = { userId: string; orgId: string; role: OrgRole };

/** What the actor may do with a learning: read it, and change, accept or
 *  delete it. */
export function learningRights(actor: LearningActor, learning: Learning): { read: boolean; write: boolean } {
  if (learning.scope === "personal") {
    const own = learning.userId === actor.userId;
    return { read: own, write: own };
  }
  if (learning.orgId !== actor.orgId) return { read: false, write: false };
  const admin = actor.role === "admin";
  // A suggestion for the org is its admins' to decide, and its suggester's to see.
  const read = learning.status === "active" || admin || learning.createdBy === actor.userId;
  return { read, write: admin };
}

/** The status a new learning starts in: a member's for the org, and anything
 *  an agent suggests, waits to be accepted. */
export function newLearningStatus(actor: LearningActor, scope: LearningScope, suggested: boolean): LearningStatus {
  if (suggested) return "suggested";
  return scope === "org" && actor.role !== "admin" ? "suggested" : "active";
}

export type LearningInput = { title: string; body: string };

/** A learning's text as sent: trimmed, inside the bounds; `partial` lets
 *  either be left out (a change). The reason it can't be taken otherwise. */
export function parseLearningText(
  raw: { title?: unknown; body?: unknown },
  { partial = false }: { partial?: boolean } = {},
): Partial<LearningInput> | string {
  const out: Partial<LearningInput> = {};
  for (const [key, max] of [
    ["title", MAX_TITLE_CHARS],
    ["body", MAX_BODY_CHARS],
  ] as const) {
    const value = raw[key];
    if (value === undefined && partial) continue;
    if (typeof value !== "string" || !value.trim()) return `\`${key}\` is the learning's ${key === "title" ? "short title" : "instruction"}, as text.`;
    // Trailing spaces and runs of blank lines are noise in a prompt.
    const text = value.trim().replace(/\n{3,}/g, "\n\n");
    if (text.length > max) return `\`${key}\` is at most ${max} characters.`;
    if (key === "title" && /[\r\n]/.test(text)) return "`title` is one line.";
    out[key] = text;
  }
  return out;
}

/** A scope as sent, or null for anything else. */
export function learningScope(value: unknown): LearningScope | null {
  return LEARNING_SCOPES.includes(value as LearningScope) ? (value as LearningScope) : null;
}

/** A status as sent, or null for anything else. */
export function learningStatus(value: unknown): LearningStatus | null {
  return LEARNING_STATUSES.includes(value as LearningStatus) ? (value as LearningStatus) : null;
}
