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

import { seal } from "@/lib/crypto/secret-box";

/** How many one person can connect. */
export const MAX_CLAUDE_ACCOUNTS = 10;
/** The label an account gets when it comes through a door that asks for none
 *  (the desktop app, an older `outrunner claude`). */
export const DEFAULT_LABEL = "default";
const MAX_LABEL = 32;

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

/** The label, trimmed, or what's wrong with it, for the person to read. */
export function checkLabel(raw: unknown): { label: string } | { error: string } {
  const label = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!label) return { error: "Give the account a name, like work or personal." };
  if (label.length > MAX_LABEL) return { error: `Keep the name to ${MAX_LABEL} characters.` };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(label)) {
    return { error: "Use letters, numbers, spaces, dots, dashes or underscores in the name." };
  }
  return { label };
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
