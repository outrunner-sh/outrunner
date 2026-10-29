/**
 * Long-term memory (20261103111000_memories.sql): notes an agent keeps for
 * the next sessions, one or two lines each, at two scopes. A person's own
 * are theirs alone, and every new session of theirs loads the newest; the
 * org's are shared with its members, each a note its writer or an admin may
 * delete, read on request and never loaded on their own, so no member's
 * agent writes into another's instructions unread. Nothing is added but by an agent's
 * `outrunner-session remember` (lib/session-tools), and nothing is mined:
 * Settings → Memory shows every note, to delete.
 *
 * The operations every caller goes through, on a store given (lib/db/
 * memories.ts), so tests run them on one of their own.
 */

import type { OrgRole } from "@/lib/orgs/active";

export type MemoryScope = "org" | "personal";

export type Memory = {
  id: string;
  scope: MemoryScope;
  /** Who noted it. */
  userId: string;
  /** The org it's shared with; null for a person's own. */
  orgId: string | null;
  body: string;
  /** The session that noted it. */
  workspaceId: string | null;
  createdAt: string;
};

export type MemoryActor = { userId: string; orgId: string; role: OrgRole };

export const MAX_MEMORY_CHARS = 1000;

/** The most notes a scope keeps: past it, a note is refused until some are
 *  deleted, rather than the oldest quietly dropped. */
export const MAX_MEMORIES = 500;

export type MemoryStore = {
  /** A scope's notes, newest first: the org's shared ones (`orgId`), or a
   *  person's own (`userId`). */
  list(where: { orgId: string } | { userId: string }): Promise<Memory[]>;
  get(id: string): Promise<Memory | null>;
  insert(row: { userId: string; orgId: string | null; body: string; workspaceId: string | null }): Promise<Memory>;
  remove(id: string): Promise<boolean>;
};

/** Why a note couldn't be read, added or deleted, said as the routes answer. */
export class MemoryError extends Error {
  readonly status: 400 | 403 | 404 | 409;

  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "MemoryError";
    this.status = status;
  }
}

/** What the actor may do with a note. */
export function memoryRights(actor: MemoryActor, memory: Memory): { read: boolean; delete: boolean } {
  if (memory.scope === "personal") {
    const own = memory.userId === actor.userId;
    return { read: own, delete: own };
  }
  if (memory.orgId !== actor.orgId) return { read: false, delete: false };
  return { read: true, delete: actor.role === "admin" || memory.userId === actor.userId };
}

/** What looks like a secret: a note is never one (it's in every prompt, and
 *  on a page others in the org read). */
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk|pk)-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:sk|rk|pk|whsec)_(?:live_|test_)?[A-Za-z0-9]{16,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
  /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bor_(?:key|cli)_[A-Za-z0-9_-]{16,}/,
];

/** A note as sent: trimmed, one to a thousand characters, and no secret; the
 *  reason it can't be kept otherwise. */
export function parseMemoryBody(value: unknown): string | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: "A note is text: what to remember." };
  const body = value.trim().replace(/\n{3,}/g, "\n\n");
  if (body.length > MAX_MEMORY_CHARS) return { error: `A note is at most ${MAX_MEMORY_CHARS} characters: keep it to what matters.` };
  if (SECRET.some((pattern) => pattern.test(body))) {
    return { error: "That looks like it holds a secret (a key or token). Memory never keeps one: note where it's kept instead." };
  }
  return body;
}

function where(actor: MemoryActor, scope: MemoryScope): { orgId: string } | { userId: string } {
  return scope === "org" ? { orgId: actor.orgId } : { userId: actor.userId };
}

/** The notes the actor may read, newest first: their own, then the org's;
 *  `query` keeps those holding each of its words. */
export async function listMemories(
  actor: MemoryActor,
  store: MemoryStore,
  { scope, query }: { scope?: MemoryScope; query?: string } = {},
): Promise<Memory[]> {
  const scopes: MemoryScope[] = scope ? [scope] : ["personal", "org"];
  const lists = await Promise.all(scopes.map((s) => store.list(where(actor, s))));
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return lists
    .flat()
    .filter((m) => memoryRights(actor, m).read)
    .filter((m) => words.every((w) => m.body.toLowerCase().includes(w)));
}

/** Keep a note, for the actor or shared with their org. */
export async function addMemory(
  actor: MemoryActor,
  store: MemoryStore,
  input: { scope: MemoryScope; body: unknown; workspaceId?: string | null },
): Promise<Memory> {
  const body = parseMemoryBody(input.body);
  if (typeof body !== "string") throw new MemoryError(400, body.error);
  const existing = await store.list(where(actor, input.scope));
  // The same note again is the one already kept, even in a full memory.
  const same = existing.find((m) => m.body === body);
  if (same) return same;
  if (existing.length >= MAX_MEMORIES) {
    throw new MemoryError(409, `Memory holds ${MAX_MEMORIES} notes, the most it keeps. Ask the user to delete some in Settings → Memory.`);
  }
  return store.insert({
    userId: actor.userId,
    orgId: input.scope === "org" ? actor.orgId : null,
    body,
    workspaceId: input.workspaceId ?? null,
  });
}

/** Delete a note: one's own, or as an admin, any the org shares. */
export async function deleteMemory(actor: MemoryActor, store: MemoryStore, id: string): Promise<void> {
  const memory = await store.get(id);
  if (!memory || !memoryRights(actor, memory).read) throw new MemoryError(404, "No note by that id that you can see.");
  if (!memoryRights(actor, memory).delete) throw new MemoryError(403, "Only its writer or the org's admins delete a shared note.");
  if (!(await store.remove(id))) throw new MemoryError(404, "No note by that id that you can see.");
}
