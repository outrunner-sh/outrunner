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
 * exception: {@link neevAiKey}, the user's own capped Neev AI key, which a local
 * session's page hands to the agent on the user's Mac (see that function). The
 * UI otherwise gets {@link credentialStatus}: presence and a masked hint only.
 */

import { open, sameSecret, seal } from "@/lib/crypto/secret-box";
import {
  createUserKey,
  disableUserKey,
  keySource,
  NeevAiUnavailableError,
  sharedApiKey,
} from "@/lib/openrouter/keys";
import { ensureUserKey } from "@/lib/openrouter/user-key";
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
 * Open a stored ciphertext, degrading a decrypt failure to null. Logs the user
 * id and which credential failed — never the ciphertext or the error's own
 * message, which can echo plaintext fragments back into the server log.
 */
function openOrNull(
  ciphertext: string | null | undefined,
  userId: string,
  which: "github" | "anthropic",
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

/**
 * The OpenRouter key this user's sessions run Outrunner's models on: the shared
 * API key when the server has only that, otherwise the user's own key, capped
 * by OpenRouter at the monthly allowance, created the first time they pick one
 * of the models and then kept (OpenRouter tracks the allowance per key, so a
 * fresh key each time would hand out a fresh $5). The races and failures are
 * handled in {@link ensureUserKey}.
 *
 * It is returned in plaintext because a local session runs on the user's Mac,
 * where only the page can hand it to the agent.
 */
export async function neevAiKey(userId: string): Promise<string> {
  const source = keySource();
  if (source === null) throw new NeevAiUnavailableError();
  if (source === "shared") return sharedApiKey() as string; // see lib/openrouter/keys.ts

  const supabase = createSupabaseAdminClient();
  // The conditional claim needs a row to match.
  const { error: rowError } = await supabase
    .from("user_credentials")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  if (rowError) throw rowError;

  return ensureUserKey(
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
      // Labelled by user id only: the OpenRouter dashboard needs no personal data.
      create: () => createUserKey(`outrunner user ${userId}`),
      disable: disableUserKey,
      log: (message, error) => console.error(`${message} (user ${userId})`, error),
    },
  );
}
