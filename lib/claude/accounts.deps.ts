/**
 * A person's Claude accounts in the database (claude_accounts), for the rules
 * in accounts.ts. Until 20261121100000_claude_accounts.sql is applied there
 * is no table: {@link loadClaudeAccounts} answers null and callers keep using
 * the single Claude slot as before.
 *
 * Callers settle the Claude slot first (settleClaudeSlot in lib/db/credentials,
 * which moves an Anthropic API key out of it), so a key is never adopted as a
 * subscription. Not imported here: credentials.ts imports this module.
 */

import {
  adoptSlot,
  ordered,
  sessionAccount,
  type ClaudeAccount,
  type ClaudeAccountStore,
} from "@/lib/claude/accounts";
import { open } from "@/lib/crypto/secret-box";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

type Row = Database["public"]["Tables"]["claude_accounts"]["Row"];

/** The table isn't there yet: the database is older than this release. */
export class ClaudeAccountsUnavailable extends Error {
  constructor() {
    super("Several Claude accounts aren't available on this deployment yet.");
    this.name = "ClaudeAccountsUnavailable";
  }
}

function fail(error: { code?: string; message?: string }): never {
  if (probeStatus(error) === "missing") throw new ClaudeAccountsUnavailable();
  throw error;
}

function toAccount(row: Row): ClaudeAccount {
  return {
    id: row.id,
    label: row.label,
    ciphertext: row.token_ciphertext,
    hint: row.token_hint,
    position: row.position,
    limitedUntil: row.limited_until,
    needsReconnect: row.needs_reconnect,
    createdAt: row.created_at,
  };
}

/** Whether a sealed token opens with this deployment's key (and any previous
 *  one, lib/crypto/secret-box.ts), each tried once per store. */
function readableWith(): (account: ClaudeAccount) => boolean {
  const known = new Map<string, boolean>();
  return (account) => {
    const key = `${account.id}:${account.ciphertext}`;
    if (!known.has(key)) {
      let opens = false;
      try {
        opens = open(account.ciphertext).length > 0;
      } catch {
        opens = false;
      }
      known.set(key, opens);
    }
    return known.get(key)!;
  };
}

/** One person's accounts. Every call throws ClaudeAccountsUnavailable before the migration. */
export function claudeAccountStore(userId: string): ClaudeAccountStore {
  const db = createSupabaseAdminClient();
  const readable = readableWith();
  return {
    readable,
    async list() {
      const { data, error } = await db.from("claude_accounts").select("*").eq("user_id", userId);
      if (error) fail(error);
      return ordered((data ?? []).map(toAccount));
    },
    async insert(account) {
      const { error } = await db.from("claude_accounts").insert({
        user_id: userId,
        label: account.label,
        token_ciphertext: account.ciphertext,
        token_hint: account.hint,
        position: account.position,
      });
      if (error) fail(error);
    },
    async update(id, patch) {
      const { error } = await db
        .from("claude_accounts")
        .update({
          ...(patch.label !== undefined && { label: patch.label }),
          ...(patch.ciphertext !== undefined && { token_ciphertext: patch.ciphertext }),
          ...(patch.hint !== undefined && { token_hint: patch.hint }),
          ...(patch.position !== undefined && { position: patch.position }),
          ...(patch.limitedUntil !== undefined && { limited_until: patch.limitedUntil }),
          ...(patch.needsReconnect !== undefined && { needs_reconnect: patch.needsReconnect }),
        })
        .eq("id", id)
        .eq("user_id", userId);
      if (error) fail(error);
    },
    async remove(id) {
      const { error } = await db.from("claude_accounts").delete().eq("id", id).eq("user_id", userId);
      if (error) fail(error);
    },
    async mirror(first) {
      const { data, error } = await db
        .from("user_credentials")
        .select("anthropic_key_ciphertext")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      const current = data?.anthropic_key_ciphertext ?? null;
      const next = first?.ciphertext ?? null;
      // Untouched when it already holds it: the desktop app watches the
      // slot's time change to tell a reconnect finished.
      if (current === next) return;
      const { error: writeError } = await db.from("user_credentials").upsert(
        {
          user_id: userId,
          anthropic_key_ciphertext: next,
          anthropic_key_hint: first ? first.hint : null,
          anthropic_key_updated_at: first ? new Date().toISOString() : null,
        },
        { onConflict: "user_id" },
      );
      if (writeError) throw writeError;
    },
  };
}

async function readSlot(userId: string): Promise<{ ciphertext: string; hint: string | null } | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_credentials")
    .select("anthropic_key_ciphertext, anthropic_key_hint")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.anthropic_key_ciphertext ? { ciphertext: data.anthropic_key_ciphertext, hint: data.anthropic_key_hint } : null;
}

/**
 * The person's accounts, adopting the Claude slot's token as "default" when
 * they have none yet. Null before the migration. The slot must be settled.
 */
export async function loadClaudeAccounts(userId: string): Promise<ClaudeAccount[] | null> {
  const store = claudeAccountStore(userId);
  try {
    return await adoptSlot(store, await readSlot(userId));
  } catch (error) {
    if (error instanceof ClaudeAccountsUnavailable) return null;
    throw error;
  }
}

/**
 * The sealed token a new session runs the person's Claude subscription on:
 * the first account that can run (accounts.ts), else `slotCiphertext`, what
 * sessions ran on before there were several. The slot must be settled.
 */
export async function sessionClaudeCiphertext(userId: string, slotCiphertext: string | null): Promise<string | null> {
  const accounts = await loadClaudeAccounts(userId);
  if (!accounts || accounts.length === 0) return slotCiphertext;
  return sessionAccount(accounts, Date.now(), readableWith())?.ciphertext ?? slotCiphertext;
}
