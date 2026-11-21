/**
 * A person's Claude subscriptions (Settings → Claude subscription): each a
 * `claude setup-token` they pasted under a label of their own ("work",
 * "personal"), in an order they set. A session starts on the first that can
 * run: not at its usage limit, not rejected by Anthropic.
 *
 * Their own only. An org shares API keys, never a subscription: Anthropic's
 * terms have each person sign in with their own (docs: Team Claude Logins).
 *
 * The rules are here, the database in accounts.deps.ts, so tests run them
 * against a store of their own. The Claude slot (user_credentials.anthropic_
 * key_*) keeps holding the first account in order, so everything that reads
 * it — the workspace gate, the desktop app, `outrunner claude` — is unchanged.
 */

import { createHash } from "node:crypto";

import { checkLabel } from "@/lib/claude/account-label";
import { seal } from "@/lib/crypto/secret-box";

export { checkLabel };

/** How many one person can connect. */
export const MAX_CLAUDE_ACCOUNTS = 10;
/** The label an account gets when it comes through a door that asks for none
 *  (the desktop app, an older `outrunner claude`). */
export const DEFAULT_LABEL = "default";

export type ClaudeAccount = {
  id: string;
  label: string;
  /** The token, sealed. */
  ciphertext: string;
  /** Its last 4 characters. */
  hint: string | null;
  position: number;
  /** ISO; skipped until then. */
  limitedUntil: string | null;
  /** Anthropic rejected it: skipped until it's pasted again. */
  needsReconnect: boolean;
  /** ISO. */
  createdAt: string;
};

/** What Settings shows of an account: never the token. */
export type ClaudeAccountView = {
  id: string;
  label: string;
  last4: string | null;
  position: number;
  addedAt: string;
  limitedUntil: string | null;
  needsReconnect: boolean;
};

export type ClaudeAccountPatch = Partial<Pick<ClaudeAccount, "label" | "ciphertext" | "hint" | "position" | "limitedUntil" | "needsReconnect">>;

/** One person's accounts, as the rules need them. */
export type ClaudeAccountStore = {
  list(): Promise<ClaudeAccount[]>;
  insert(account: Pick<ClaudeAccount, "label" | "ciphertext" | "hint" | "position">): Promise<void>;
  update(id: string, patch: ClaudeAccountPatch): Promise<void>;
  remove(id: string): Promise<void>;
  /** Make the Claude slot hold `first`'s token, or nothing. */
  mirror(first: ClaudeAccount | null): Promise<void>;
};

/** A request the person can fix; `status` is the HTTP status to answer with. */
export class ClaudeAccountError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ClaudeAccountError";
    this.status = status;
  }
}

function sameLabel(a: string, b: string): boolean {
  return a.toLocaleLowerCase("en") === b.toLocaleLowerCase("en");
}

/** In the person's order; ties (two saves at once) by age. */
export function ordered(accounts: readonly ClaudeAccount[]): ClaudeAccount[] {
  return [...accounts].sort(
    (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** Whether a session can start on it at `now` (ms). */
export function usable(account: ClaudeAccount, now: number): boolean {
  if (account.needsReconnect) return false;
  return !account.limitedUntil || !(Date.parse(account.limitedUntil) > now);
}

/**
 * The account a new session runs on: the first in order that can run. When
 * none can, the first in order all the same, so the session starts and
 * Claude Code itself says when the limit resets, rather than Outrunner
 * refusing as if nothing were connected. Null with no accounts.
 */
export function sessionAccount(accounts: readonly ClaudeAccount[], now: number): ClaudeAccount | null {
  const sorted = ordered(accounts);
  return sorted.find((account) => usable(account, now)) ?? sorted[0] ?? null;
}

export function view(account: ClaudeAccount): ClaudeAccountView {
  return {
    id: account.id,
    label: account.label,
    last4: account.hint ? account.hint.slice(-4) : null,
    position: account.position,
    addedAt: account.createdAt,
    limitedUntil: account.limitedUntil,
    needsReconnect: account.needsReconnect,
  };
}

async function settled(store: ClaudeAccountStore): Promise<ClaudeAccount[]> {
  const after = ordered(await store.list());
  await store.mirror(after[0] ?? null);
  return after;
}

function sealed(token: string): Pick<ClaudeAccount, "ciphertext" | "hint"> {
  const trimmed = token.trim();
  return { ciphertext: seal(trimmed), hint: trimmed.slice(-4) };
}

/**
 * Connect `token` under `label`, or replace the token of the account already
 * under that label (any case). A replaced token starts clean: its limit and
 * any rejection belonged to the old one.
 */
export async function saveAccount(store: ClaudeAccountStore, label: string, token: string): Promise<ClaudeAccount[]> {
  const accounts = await store.list();
  const existing = accounts.find((account) => sameLabel(account.label, label));
  if (existing) {
    await store.update(existing.id, { ...sealed(token), limitedUntil: null, needsReconnect: false });
  } else {
    if (accounts.length >= MAX_CLAUDE_ACCOUNTS) {
      throw new ClaudeAccountError(`You can connect up to ${MAX_CLAUDE_ACCOUNTS} Claude accounts. Remove one first.`, 409);
    }
    const position = accounts.reduce((last, account) => Math.max(last, account.position + 1), 0);
    await store.insert({ label, ...sealed(token), position });
  }
  return settled(store);
}

/**
 * The single-token doors (the desktop app, `outrunner claude` without a
 * label) as they've always worked: replace the token sessions start on, the
 * first account's, keeping its name; or connect it as "default".
 */
export async function replaceFirstAccount(store: ClaudeAccountStore, token: string): Promise<ClaudeAccount[]> {
  const first = ordered(await store.list())[0];
  return saveAccount(store, first?.label ?? DEFAULT_LABEL, token);
}

export async function removeAccount(store: ClaudeAccountStore, id: string): Promise<ClaudeAccount[]> {
  const accounts = await store.list();
  if (!accounts.some((account) => account.id === id)) {
    throw new ClaudeAccountError("That Claude account isn't connected. Reload to see your accounts.", 404);
  }
  await store.remove(id);
  return settled(store);
}

/** Disconnect every account: the single-token doors' Disconnect. */
export async function removeAllAccounts(store: ClaudeAccountStore): Promise<void> {
  for (const account of await store.list()) await store.remove(account.id);
  await store.mirror(null);
}

/** Put the accounts in `ids`' order, which must name each account once. */
export async function reorderAccounts(store: ClaudeAccountStore, ids: readonly string[]): Promise<ClaudeAccount[]> {
  const accounts = await store.list();
  const known = new Set(accounts.map((account) => account.id));
  if (ids.length !== accounts.length || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
    throw new ClaudeAccountError("Send every Claude account once, in the new order. Reload and try again.", 409);
  }
  const at = new Map(accounts.map((account) => [account.id, account.position]));
  for (const [position, id] of ids.entries()) {
    if (at.get(id) !== position) await store.update(id, { position });
  }
  return settled(store);
}

/** How long an account is skipped when Claude Code doesn't say when its limit resets. */
export const DEFAULT_LIMIT_MS = 60 * 60 * 1000;
/** The furthest reset believed: a weekly limit, and a day to spare. */
const MAX_LIMIT_MS = 8 * 24 * 60 * 60 * 1000;

/** Until when an account at its limit is skipped: the reset Claude Code
 *  reported, when it's a believable one, else an hour from `now` (ms). */
export function limitUntil(resetsAt: string | null | undefined, now: number): string {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  return new Date(at > now && at - now <= MAX_LIMIT_MS ? at : now + DEFAULT_LIMIT_MS).toISOString();
}

/** The account holding `token`, opening each with `openToken`; null when none
 *  does (removed meanwhile, or a token from before there were accounts). */
export function accountWithToken(
  accounts: readonly ClaudeAccount[],
  token: string,
  openToken: (ciphertext: string) => string,
): ClaudeAccount | null {
  return accountMatching(accounts, (opened) => sameToken(opened, token), openToken);
}

/** The account whose token's SHA-256 (hex) is `hash`: how a box names the
 *  account it's on without sending the token. */
export function accountWithTokenHash(
  accounts: readonly ClaudeAccount[],
  hash: string,
  openToken: (ciphertext: string) => string,
): ClaudeAccount | null {
  const wanted = hash.toLowerCase();
  return accountMatching(accounts, (opened) => sameToken(createHash("sha256").update(opened).digest("hex"), wanted), openToken);
}

function accountMatching(
  accounts: readonly ClaudeAccount[],
  matches: (token: string) => boolean,
  openToken: (ciphertext: string) => string,
): ClaudeAccount | null {
  for (const account of accounts) {
    try {
      if (matches(openToken(account.ciphertext))) return account;
    } catch {
      // Unreadable (a key change): not this one.
    }
  }
  return null;
}

function sameToken(a: string, b: string): boolean {
  // Lengths leak nothing useful here: every setup-token is the same shape.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type Switch = {
  /** The account that hit its limit, now marked; null when it isn't one of theirs. */
  limited: ClaudeAccount | null;
  limitedUntil: string | null;
  /** The account to carry on with: the first other one that can run. */
  next: ClaudeAccount | null;
  /** With no next, when the first of them can run again (ISO). */
  firstReset: string | null;
};

/**
 * `limited` hit its usage limit (resetting at `resetsAt`, when Claude Code
 * said): mark it, so no session starts on it until then, and name the account
 * to carry on with. Never the limited one again, even when every other is
 * out too.
 */
export async function switchFromLimited(
  store: ClaudeAccountStore,
  limited: ClaudeAccount | null,
  resetsAt: string | null,
  now: number,
): Promise<Switch> {
  const limitedUntil = limited ? limitUntil(resetsAt, now) : null;
  if (limited && limitedUntil) await store.update(limited.id, { limitedUntil });
  const accounts = ordered(await store.list());
  const next = accounts.find((account) => account.id !== limited?.id && usable(account, now)) ?? null;
  const resets = accounts
    .filter((account) => !account.needsReconnect && account.limitedUntil)
    .map((account) => Date.parse(account.limitedUntil!))
    .filter((at) => at > now)
    .sort((a, b) => a - b);
  return { limited, limitedUntil, next, firstReset: next || resets.length === 0 ? null : new Date(resets[0]).toISOString() };
}

/** What a box hears back when its session hits a usage limit
 *  (app/api/runtime/claude-account): the token to carry on with, or none. */
export type LimitAnswer =
  | { token: string; label: string; from: string | null }
  | { token: null; from: string | null; firstReset: string | null };

/**
 * A box's session hit its usage limit on the token whose SHA-256 is
 * `tokenSha256`: mark that account and answer with the next one's token. An
 * account whose token won't open is skipped, as if it weren't there.
 */
export async function answerLimit(
  store: ClaudeAccountStore,
  input: { tokenSha256: string; resetsAt: string | null; now: number },
  openToken: (ciphertext: string) => string,
): Promise<LimitAnswer> {
  const limited = accountWithTokenHash(await store.list(), input.tokenSha256, openToken);
  const result = await switchFromLimited(store, limited, input.resetsAt, input.now);
  const from = limited?.label ?? null;
  if (!result.next) return { token: null, from, firstReset: result.firstReset };
  try {
    return { token: openToken(result.next.ciphertext), label: result.next.label, from };
  } catch {
    return { token: null, from, firstReset: result.firstReset };
  }
}

/**
 * Accounts from before there were several: a token in the Claude slot with
 * no accounts yet becomes the first, "default". Run before reading them.
 */
export async function adoptSlot(
  store: ClaudeAccountStore,
  slot: { ciphertext: string; hint: string | null } | null,
): Promise<ClaudeAccount[]> {
  const accounts = await store.list();
  if (accounts.length > 0 || !slot) return accounts;
  try {
    await store.insert({ label: DEFAULT_LABEL, ciphertext: slot.ciphertext, hint: slot.hint, position: 0 });
  } catch {
    // Adopted at the same moment by another request: its row stands.
  }
  return store.list();
}
