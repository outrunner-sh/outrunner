/**
 * Per-user third-party credentials — the multi-user replacement for the
 * server-wide GITHUB_PAT and shared Anthropic token.
 *
 * ACCESS MODEL. `user_credentials` has RLS enabled with no policy, so the anon
 * and authenticated roles match nothing and are denied. Everything here goes
 * through the service-role client, which bypasses RLS — meaning THIS MODULE IS
 * THE ACCESS CONTROL. Every function takes an already-verified `userId` and
 * scopes its query to it; callers must pass the id from the current session
 * (`getUser()`), never a value taken from a request body, path, or query.
 *
 * Nothing here returns a decrypted secret to a browser-facing payload, with one
 * exception: {@link outrunnerModelKey}, the user's own capped key for Outrunner's models, which a local
 * session's page hands to the agent on the user's Mac (see that function). The
 * UI otherwise gets {@link credentialStatus}: presence and a masked hint only.
 */

import { dueForRenewal } from "@/lib/billing/allowance-renewal";
import { entitlingSubscriptions } from "@/lib/billing/billing-store";
import { entitlementsFor, planFor } from "@/lib/billing/entitlements";
import {
  type AllowanceState,
  type AllowanceStore,
  nextAllowance,
  refreshAllowance,
  type RefreshedAllowance,
  refuseUnusable,
} from "@/lib/billing/model-allowance";
import type { PlanId } from "@/lib/billing/plans";
import { open, sameSecret, seal } from "@/lib/crypto/secret-box";
import type { Allowance } from "@/lib/openrouter/allowance";
import {
  createUserKey,
  disableUserKey,
  keySource,
  keyUsage,
  OutrunnerModelsUnavailableError,
  setKeyLimit,
  sharedApiKey,
} from "@/lib/openrouter/keys";
import { ensureUserKey } from "@/lib/openrouter/user-key";
import { moveApiKeyFromClaudeSlot } from "@/lib/providers/claude-slot";
import { NoProviderKeyError } from "@/lib/providers/errors";
import { isProviderId, PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";
import { DEFAULT_BOX_SIZE, isBoxSizeId, type BoxSizeId } from "@/lib/runtime/box-sizes";
import type { ModalToken } from "@/lib/runtime/sandbox/modal";
import type { Database } from "@/lib/supabase/database.types";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** What the settings UI may safely see: presence, not values. */
export type CredentialStatus = {
  github: { connected: boolean; login: string | null; updatedAt: string | null };
  anthropic: { connected: boolean; hint: string | null; updatedAt: string | null };
};

/**
 * Presence and masked hints for the signed-in user. Deliberately returns no
 * ciphertext and no plaintext, so it is safe to serialize into a page payload.
 */
export async function credentialStatus(userId: string): Promise<CredentialStatus> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_credentials")
    // One string literal, not a concatenation: supabase-js infers the row shape
    // from this argument's literal type, and splitting it collapses the result
    // to GenericStringError.
    .select(
      "github_token_ciphertext, github_token_login, github_token_updated_at, anthropic_key_ciphertext, anthropic_key_hint, anthropic_key_updated_at",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  return {
    github: {
      connected: Boolean(data?.github_token_ciphertext),
      login: data?.github_token_login ?? null,
      updatedAt: data?.github_token_updated_at ?? null,
    },
    anthropic: {
      connected: Boolean(data?.anthropic_key_ciphertext),
      hint: data?.anthropic_key_hint ?? null,
      updatedAt: data?.anthropic_key_updated_at ?? null,
    },
  };
}

/**
 * The user's GitHub token, or null when they have none stored or the stored
 * value cannot be opened.
 *
 * A failed decrypt (rotated CREDENTIALS_ENCRYPTION_KEY, corrupted row) is
 * reported as "no credential" rather than thrown: the caller's correct response
 * is identical either way — send the user back through GitHub to reconnect —
 * and a throw here would turn a recoverable state into a 500.
 */
export async function getGithubToken(userId: string): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_credentials")
    .select("github_token_ciphertext")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return openOrNull(data?.github_token_ciphertext, userId, "github");
}

/**
 * Persist the GitHub OAuth provider_token captured at the auth callback.
 *
 * Supabase exposes provider_token only in the session immediately after OAuth
 * and never refreshes it, so the callback is the one chance to capture it. Skips
 * the write when the token is unchanged, so an ordinary re-login doesn't churn
 * `github_token_updated_at` (which the UI shows as "connected <date>").
 */
export async function setGithubToken(
  userId: string,
  token: string,
  login: string,
): Promise<void> {
  const existing = await getGithubToken(userId);
  if (existing && sameSecret(existing, token)) return;

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("user_credentials").upsert(
    {
      user_id: userId,
      github_token_ciphertext: seal(token),
      github_token_login: login,
      github_token_updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
}

/** The user's Anthropic API key, or null when unset or unreadable. */
export async function getAnthropicKey(userId: string): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_credentials")
    .select("anthropic_key_ciphertext")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return openOrNull(data?.anthropic_key_ciphertext, userId, "anthropic");
}

/**
 * Store the user's own ANTHROPIC_API_KEY. The hint is the last 4 characters,
 * kept in clear so settings can render `sk-…AbCd` without decrypting.
 */
export async function setAnthropicKey(userId: string, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Anthropic API key cannot be empty");

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("user_credentials").upsert(
    {
      user_id: userId,
      anthropic_key_ciphertext: seal(trimmed),
      anthropic_key_hint: trimmed.slice(-4),
      anthropic_key_updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
}

/** Forget the user's Anthropic key. Their GitHub connection is left alone. */
export async function clearAnthropicKey(userId: string): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("user_credentials")
    .update({
      anthropic_key_ciphertext: null,
      anthropic_key_hint: null,
      anthropic_key_updated_at: null,
    })
    .eq("user_id", userId);

  if (error) throw error;
}

/**
 * Where the user's cloud sessions run (Settings → Sandbox): Outrunner's own
 * sandboxes, the deployment's provider and the default, or their own Daytona
 * or Modal account on a key they supply.
 */
export type SandboxChoice = "outrunner" | "daytona" | "modal";

/** A stored key, as the page sees it: whether there is one, and its last 4
 *  characters. */
export type StoredKey = { connected: boolean; hint: string | null; updatedAt: string | null };

export type SandboxSettings = {
  sandbox: SandboxChoice;
  daytona: StoredKey;
  /** The Modal token; its hint is the token id's last 4. */
  modal: StoredKey;
  /** How big a new sandbox is, on Outrunner's or the user's own Modal
   *  (lib/runtime/box-sizes.ts). */
  boxSize: BoxSizeId;
};

const SANDBOX_COLUMNS = "sandbox, daytona_key_ciphertext, daytona_key_hint, daytona_key_updated_at";
const MODAL_COLUMNS = "modal_token_ciphertext, modal_token_hint, modal_token_updated_at";

export async function getSandboxSettings(userId: string): Promise<SandboxSettings> {
  const supabase = createSupabaseAdminClient();
  const read = (columns: string) =>
    supabase.from("user_credentials").select(columns).eq("user_id", userId).maybeSingle();
  let { data, error } = await read(`${SANDBOX_COLUMNS}, box_size, ${MODAL_COLUMNS}`);
  // Each migration not yet applied reads as before it: until
  // 20261013140000_user_modal.sql, no Modal token; until
  // 20261013130000_user_box_size.sql, the default size; and until
  // 20261013120000_user_sandbox.sql, everyone on Outrunner's sandboxes.
  if (error && probeStatus(error) === "outdated") ({ data, error } = await read(`${SANDBOX_COLUMNS}, box_size`));
  if (error && probeStatus(error) === "outdated") ({ data, error } = await read(SANDBOX_COLUMNS));
  if (error && probeStatus(error) === "outdated") ({ data, error } = { data: null, error: null });
  if (error) throw error;
  const row = data as Partial<Database["public"]["Tables"]["user_credentials"]["Row"]> | null;
  return {
    sandbox: row?.sandbox ?? "outrunner",
    daytona: {
      connected: Boolean(row?.daytona_key_ciphertext),
      hint: row?.daytona_key_hint ?? null,
      updatedAt: row?.daytona_key_updated_at ?? null,
    },
    modal: {
      connected: Boolean(row?.modal_token_ciphertext),
      hint: row?.modal_token_hint ?? null,
      updatedAt: row?.modal_token_updated_at ?? null,
    },
    boxSize: isBoxSizeId(row?.box_size) ? row.box_size : DEFAULT_BOX_SIZE,
  };
}

/** Make the user's new sandboxes this size. */
export async function setBoxSize(userId: string, size: BoxSizeId): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("user_credentials")
    .upsert({ user_id: userId, box_size: size }, { onConflict: "user_id" });

  if (error) throw error;
}

export async function setSandboxChoice(userId: string, sandbox: SandboxChoice): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("user_credentials")
    .upsert({ user_id: userId, sandbox }, { onConflict: "user_id" });

  if (error) throw error;
}

/** The user's Daytona API key, or null when unset or unreadable. */
export async function getDaytonaKey(userId: string): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_credentials")
    .select("daytona_key_ciphertext")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return openOrNull(data?.daytona_key_ciphertext, userId, "daytona");
}

/** Store the user's Daytona API key; the hint is its last 4 characters. */
export async function setDaytonaKey(userId: string, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Daytona API key cannot be empty");

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("user_credentials").upsert(
    {
      user_id: userId,
      daytona_key_ciphertext: seal(trimmed),
      daytona_key_hint: trimmed.slice(-4),
      daytona_key_updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
}

/** Forget the user's Daytona key. Their sessions can't run on Daytona without
 *  it, so if that's where they ran, new ones go back to Outrunner's sandboxes. */
export async function clearDaytonaKey(userId: string): Promise<void> {
  await forgetSandboxKey(userId, "daytona", {
    daytona_key_ciphertext: null,
    daytona_key_hint: null,
    daytona_key_updated_at: null,
  });
}

/** The user's own sandbox keys (lib/runtime/sandbox-choice.ts), each read
 *  only when a box of theirs is reached. */
export function ownSandboxKeys(userId: string): {
  daytona: () => Promise<string | null>;
  modal: () => Promise<ModalToken | null>;
} {
  return { daytona: () => getDaytonaKey(userId), modal: () => getModalToken(userId) };
}

/** The user's Modal token, or null when unset or unreadable. */
export async function getModalToken(userId: string): Promise<ModalToken | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_credentials")
    .select("modal_token_ciphertext")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  const opened = openOrNull(data?.modal_token_ciphertext, userId, "modal");
  if (!opened) return null;
  try {
    const token = JSON.parse(opened) as Partial<ModalToken>;
    return token.tokenId && token.tokenSecret ? { tokenId: token.tokenId, tokenSecret: token.tokenSecret } : null;
  } catch {
    console.error(`Could not read the Modal token for user ${userId}; treating as unset`);
    return null;
  }
}

/** Store the user's Modal token; the hint is its id's last 4 characters. */
export async function setModalToken(userId: string, token: ModalToken): Promise<void> {
  const tokenId = token.tokenId.trim();
  const tokenSecret = token.tokenSecret.trim();
  if (!tokenId || !tokenSecret) throw new Error("Modal token id and secret cannot be empty");

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("user_credentials").upsert(
    {
      user_id: userId,
      modal_token_ciphertext: seal(JSON.stringify({ tokenId, tokenSecret })),
      modal_token_hint: tokenId.slice(-4),
      modal_token_updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
}

/** Forget the user's Modal token, and move new sessions back to Outrunner's
 *  sandboxes if they ran on Modal. */
export async function clearModalToken(userId: string): Promise<void> {
  await forgetSandboxKey(userId, "modal", {
    modal_token_ciphertext: null,
    modal_token_hint: null,
    modal_token_updated_at: null,
  });
}

/** Clear one sandbox's key, and leave that sandbox for Outrunner's when it was
 *  the user's choice: their other key, and a choice of the other, stay. */
async function forgetSandboxKey(
  userId: string,
  sandbox: Exclude<SandboxChoice, "outrunner">,
  cleared: Partial<Database["public"]["Tables"]["user_credentials"]["Row"]>,
): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("user_credentials").update(cleared).eq("user_id", userId);
  if (error) throw error;
  const { error: moveError } = await supabase
    .from("user_credentials")
    .update({ sandbox: "outrunner" })
    .eq("user_id", userId)
    .eq("sandbox", sandbox);
  if (moveError) throw moveError;
}

/**
 * Open a stored ciphertext, degrading a decrypt failure to null. Logs the user
 * id and which credential failed — never the ciphertext or the error's own
 * message, which can echo plaintext fragments back into the server log.
 */
function openOrNull(
  ciphertext: string | null | undefined,
  userId: string,
  which: "github" | "anthropic" | "daytona" | "modal" | ProviderId,
): string | null {
  if (!ciphertext) return null;
  try {
    return open(ciphertext);
  } catch {
    console.error(
      `Could not open ${which} credential for user ${userId}; ` +
        `treating as unset (rotated CREDENTIALS_ENCRYPTION_KEY?)`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// The user's own keys for model providers (Settings → Providers), one row per
// provider in user_provider_keys (lib/providers/registry.ts). Saved for
// OpenRouter, Outrunner's models run on it, and OpenRouter bills them,
// instead of on the server's key.
// ---------------------------------------------------------------------------

const NO_KEY: StoredKey = { connected: false, hint: null, updatedAt: null };

/** Whether a read failed only because the table isn't there yet. */
function beforeProviderKeys(error: { code?: string }): boolean {
  return probeStatus(error) === "missing";
}

/**
 * Which providers the user has a key for, and each one's last 4. Until
 * 20261019120000_user_provider_keys.sql is applied, the OpenRouter key is
 * read from where it was before, and there are no others.
 */
export async function getProviderKeyStatuses(userId: string): Promise<Record<ProviderId, StoredKey>> {
  const statuses = Object.fromEntries(PROVIDER_IDS.map((id) => [id, NO_KEY])) as Record<ProviderId, StoredKey>;
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_provider_keys")
    .select("provider, key_hint, updated_at")
    .eq("user_id", userId);
  if (error && beforeProviderKeys(error)) {
    statuses.openrouter = await legacyOpenRouterKeyStatus(userId);
    return statuses;
  }
  if (error) throw error;
  for (const row of data) {
    if (isProviderId(row.provider)) {
      statuses[row.provider] = { connected: true, hint: row.key_hint, updatedAt: row.updated_at };
    }
  }
  return statuses;
}

/** The user's key for `provider`, or null when unset or unreadable. */
export async function getProviderKey(userId: string, provider: ProviderId): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_provider_keys")
    .select("key_ciphertext")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error && beforeProviderKeys(error)) {
    return provider === "openrouter" ? legacyOpenRouterKey(userId) : null;
  }
  if (error) throw error;
  return openOrNull(data?.key_ciphertext, userId, provider);
}

/** Store the user's key for `provider`; the hint is its last 4 characters. */
export async function setProviderKey(userId: string, provider: ProviderId, apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error(`${provider} key cannot be empty`);
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("user_provider_keys").upsert(
    {
      user_id: userId,
      provider,
      key_ciphertext: seal(key),
      key_hint: key.slice(-4),
    },
    // A replaced key's updated_at is the table's trigger's to set.
    { onConflict: "user_id,provider" },
  );
  if (error) throw error;
}

/** Forget the user's key for `provider`. */
export async function clearProviderKey(userId: string, provider: ProviderId): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("user_provider_keys").delete().eq("user_id", userId).eq("provider", provider);
  if (error) throw error;
  // An OpenRouter key is also where it was before user_provider_keys, until
  // a later release drops those columns: left there, the migration's second
  // run would copy a removed key back.
  if (provider === "openrouter") {
    const { error: legacyError } = await supabase
      .from("user_credentials")
      .update({ openrouter_key_ciphertext: null, openrouter_key_hint: null, openrouter_key_updated_at: null })
      .eq("user_id", userId);
    if (legacyError && probeStatus(legacyError) !== "outdated") throw legacyError;
  }
}

/** Whether the user runs Outrunner's models on an OpenRouter key of their
 *  own. A database from before that key was stored says no. */
export async function hasOwnOpenRouterKey(userId: string): Promise<boolean> {
  try {
    return (await getProviderKeyStatuses(userId)).openrouter.connected;
  } catch (error) {
    if (probeStatus(error as { code?: string }) === "outdated") return false;
    throw error;
  }
}

/** The OpenRouter key's status where it was stored before
 *  user_provider_keys; none on a database older still. */
async function legacyOpenRouterKeyStatus(userId: string): Promise<StoredKey> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_credentials")
    .select("openrouter_key_ciphertext, openrouter_key_hint, openrouter_key_updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && probeStatus(error) === "outdated") return NO_KEY;
  if (error) throw error;
  return {
    connected: Boolean(data?.openrouter_key_ciphertext),
    hint: data?.openrouter_key_hint ?? null,
    updatedAt: data?.openrouter_key_updated_at ?? null,
  };
}

async function legacyOpenRouterKey(userId: string): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_credentials")
    .select("openrouter_key_ciphertext")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && probeStatus(error) === "outdated") return null;
  if (error) throw error;
  return openOrNull(data?.openrouter_key_ciphertext, userId, "openrouter");
}

/**
 * Move an Anthropic API key out of the Claude slot to the Anthropic provider
 * (lib/providers/claude-slot.ts). Run before either is read. A database
 * without user_provider_keys keeps the key where it is.
 */
export async function settleClaudeSlot(userId: string): Promise<void> {
  const supabase = createSupabaseAdminClient();
  try {
    await moveApiKeyFromClaudeSlot(
      {
        async readSlot() {
          const { data, error } = await supabase
            .from("user_credentials")
            .select("anthropic_key_ciphertext")
            .eq("user_id", userId)
            .maybeSingle();
          if (error) throw error;
          return data?.anthropic_key_ciphertext ?? null;
        },
        async copyToProvider(ciphertext, hint) {
          const { error } = await supabase
            .from("user_provider_keys")
            .upsert(
              { user_id: userId, provider: "anthropic", key_ciphertext: ciphertext, key_hint: hint },
              { onConflict: "user_id,provider", ignoreDuplicates: true },
            );
          if (error) throw error;
        },
        async clearSlotIf(ciphertext) {
          const { error } = await supabase
            .from("user_credentials")
            .update({ anthropic_key_ciphertext: null, anthropic_key_hint: null, anthropic_key_updated_at: null })
            .eq("user_id", userId)
            .eq("anthropic_key_ciphertext", ciphertext);
          if (error) throw error;
        },
      },
      open,
    );
  } catch (error) {
    if (beforeProviderKeys(error as { code?: string })) return;
    throw error;
  }
}

/**
 * The credential a session runs the user's own Claude on: their subscription
 * token from the Claude slot, else (as before the Anthropic key had a place of
 * its own) their Anthropic API key. Null with neither.
 */
export async function getClaudeCredential(userId: string): Promise<string | null> {
  await settleClaudeSlot(userId);
  return (await getAnthropicKey(userId)) ?? (await getProviderKey(userId, "anthropic"));
}

/** Whether Outrunner's models are there for this user: on their own key, or
 *  on the server's. */
export async function outrunnerModelsFor(userId: string): Promise<boolean> {
  return keySource() !== null || (await hasOwnOpenRouterKey(userId));
}

/**
 * Where the user's allowance on Outrunner's models stands, as spent and cap
 * within it (a period starts at 0), or null where there's no allowance to
 * show: the server runs them on one shared key (or not at all). Before their
 * key exists, nothing is spent of their plan's allowance. A user with their
 * own key too still has this one, for the models they run on it.
 */
export async function outrunnerModelAllowance(userId: string): Promise<Allowance | null> {
  if (keySource() !== "per-user") return null;
  return (await refreshModelAllowance(userId)) ?? { usedUsd: 0, limitUsd: (await planFor(userId)).models.usd };
}

/**
 * Bring the cap on the user's own key in line with their plan and its period
 * (lib/billing/model-allowance.ts), and say where it stands within the
 * allowance. Run whenever it may have moved: a session starting on the key,
 * the sidebar reading it, a subscription changing. Null with no key yet.
 */
export async function refreshModelAllowance(userId: string): Promise<RefreshedAllowance | null> {
  if (keySource() !== "per-user") return null;
  const supabase = createSupabaseAdminClient();
  const store: AllowanceStore = {
    async read() {
      const { data, error } = await supabase
        .from("user_credentials")
        .select(
          "neev_key_hash, neev_allowance_period, neev_allowance_plan, neev_allowance_baseline_usd, neev_allowance_limit_usd",
        )
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      const state: AllowanceState | null =
        data?.neev_allowance_period && data.neev_allowance_plan
          ? {
              period: data.neev_allowance_period,
              plan: data.neev_allowance_plan as PlanId,
              baselineUsd: Number(data.neev_allowance_baseline_usd ?? 0),
              limitUsd: Number(data.neev_allowance_limit_usd ?? 0),
            }
          : null;
      return { hash: data?.neev_key_hash ?? null, state };
    },
    async claim(previous, next) {
      let update = supabase
        .from("user_credentials")
        .update({
          neev_allowance_period: next.period,
          neev_allowance_plan: next.plan,
          neev_allowance_baseline_usd: next.baselineUsd,
          neev_allowance_limit_usd: next.limitUsd,
        })
        .eq("user_id", userId);
      update = previous
        ? update.eq("neev_allowance_period", previous.period).eq("neev_allowance_plan", previous.plan)
        : update.is("neev_allowance_period", null);
      const { data, error } = await update.select("user_id");
      if (error) throw error;
      return data.length > 0;
    },
  };
  return refreshAllowance(store, {
    usage: keyUsage,
    setLimit: setKeyLimit,
    entitlements: () => entitlementsFor(userId),
  });
}

/**
 * Renew the model allowance of every paying user whose period has turned
 * over (lib/billing/allowance-renewal.ts), for sessions already running.
 * How many were renewed; a user's failure is logged and the rest go on.
 */
export async function renewDueModelAllowances(now = new Date()): Promise<number> {
  if (keySource() !== "per-user") return 0;
  const subscriptions = await entitlingSubscriptions();
  const userIds = [...new Set(subscriptions.map((s) => s.userId))];
  const stored = new Map<string, string | null>();
  for (let i = 0; i < userIds.length; i += 200) {
    const { data, error } = await createSupabaseAdminClient()
      .from("user_credentials")
      .select("user_id, neev_allowance_period")
      .in("user_id", userIds.slice(i, i + 200))
      .not("neev_key_hash", "is", null);
    if (error) throw error;
    for (const row of data) stored.set(row.user_id, row.neev_allowance_period);
  }
  let renewed = 0;
  for (const userId of dueForRenewal(subscriptions, stored, now)) {
    try {
      await refreshModelAllowance(userId);
      renewed += 1;
    } catch (error) {
      console.error(`Could not renew the model allowance of user ${userId}`, error);
    }
  }
  return renewed;
}

/** Which key Outrunner's models run on: the user's own, Outrunner's, or
 *  (auto, for a new session) theirs when they have one. */
export type OpenRouterKeyUse = "auto" | "own" | "outrunner";

/**
 * The OpenRouter key this user's sessions run Outrunner's models on: the key
 * they saved themselves, when `use` allows it and they have one; else the
 * shared API key when the server has only that, otherwise a key the server
 * made them, capped by OpenRouter at their plan's allowance, created the first
 * time they pick one of the models and then kept (OpenRouter tracks the
 * allowance per key, so a fresh key each time would hand out a fresh one). The
 * races and failures are handled in {@link ensureUserKey}. A key whose
 * allowance is spent, or that OpenRouter has disabled, is refused with a
 * ModelKeyRefusedError (lib/openrouter/keys.ts) instead.
 *
 * It is returned in plaintext because a local session runs on the user's Mac,
 * where only the page can hand it to the agent.
 */
export async function outrunnerModelKey(userId: string, use: OpenRouterKeyUse = "auto"): Promise<string> {
  if (use !== "outrunner") {
    const own = await getProviderKey(userId, "openrouter");
    if (own) return own;
    if (use === "own") throw new NoProviderKeyError("openrouter");
  }
  const source = keySource();
  if (source === null) throw new OutrunnerModelsUnavailableError();
  if (source === "shared") return sharedApiKey() as string; // see lib/openrouter/keys.ts

  const supabase = createSupabaseAdminClient();
  // The conditional claim needs a row to match.
  const { error: rowError } = await supabase
    .from("user_credentials")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  if (rowError) throw rowError;

  const key = await ensureUserKey(
    {
      async read() {
        const { data, error } = await supabase
          .from("user_credentials")
          .select("neev_key_ciphertext, neev_key_hash")
          .eq("user_id", userId)
          .single();
        if (error) throw error;
        return { ciphertext: data.neev_key_ciphertext, hash: data.neev_key_hash };
      },
      async claim(key) {
        const { data, error } = await supabase
          .from("user_credentials")
          .update({
            neev_key_ciphertext: key.ciphertext,
            neev_key_hash: key.hash,
            neev_key_created_at: key.createdAt,
          })
          .eq("user_id", userId)
          .is("neev_key_ciphertext", null)
          .select("user_id");
        if (error) throw error;
        return data.length > 0;
      },
    },
    {
      open,
      seal,
      // Labelled by user id only: the OpenRouter dashboard needs no personal
      // data. Capped as a first allowance would be, with nothing spent.
      create: async () =>
        createUserKey(
          `outrunner user ${userId}`,
          (nextAllowance(await entitlementsFor(userId), null, 0) as AllowanceState).limitUsd,
        ),
      disable: disableUserKey,
      log: (message, error) => console.error(`${message} (user ${userId})`, error),
    },
  );
  // A session starting is when a new period's allowance is most needed, and
  // the usage the refresh reads says whether the key can still run anything:
  // a spent or disabled one is refused here, with a message the user can act
  // on, not handed to a session that would fail on it. A failed refresh leaves
  // the cap where it was and the key goes out: OpenRouter's cap still holds.
  const allowance = await refreshModelAllowance(userId).catch((error: unknown) => {
    console.error(`Could not refresh the model allowance of user ${userId}`, error);
    return null;
  });
  refuseUnusable(allowance);
  return key;
}
