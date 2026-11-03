/**
 * Each user's GitHub connection for repository access: the Outrunner GitHub
 * App's user authorization (lib/github/user-auth.ts), its tokens sealed
 * (supabase/migrations/20261105100000_github_user_connections.sql).
 *
 * Service role only, like lib/db/credentials.ts: every function takes an
 * already-verified `userId`. Nothing here goes to a browser but
 * {@link GitHubConnectionStatus}, which holds no token.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import type { UserTokens } from "@/lib/github/user-auth";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A connection, its tokens opened. */
export type GitHubConnection = {
  userId: string;
  githubUserId: number;
  githubLogin: string;
  accessToken: string;
  accessExpiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
  /** The refresh token as stored, to save a renewal only over the one used. */
  refreshCiphertext: string | null;
  broken: boolean;
  updatedAt: string;
};

/** What the settings page may see of a connection. */
export type GitHubConnectionStatus = {
  login: string;
  githubUserId: number;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  broken: boolean;
  updatedAt: string;
};

type Row = {
  user_id: string;
  github_user_id: number;
  github_login: string;
  access_token_ciphertext: string;
  access_token_expires_at: string | null;
  refresh_token_ciphertext: string | null;
  refresh_token_expires_at: string | null;
  broken_at: string | null;
  updated_at: string;
};

const COLUMNS =
  "user_id, github_user_id, github_login, access_token_ciphertext, access_token_expires_at, refresh_token_ciphertext, refresh_token_expires_at, broken_at, updated_at";

/** The migration isn't applied yet: no connections, rather than an error. */
const notMigrated = (error: { code?: string }) => {
  const status = probeStatus(error);
  return status === "missing" || status === "outdated";
};

const date = (value: string | null) => (value ? new Date(value) : null);

function toConnection(row: Row): GitHubConnection | null {
  try {
    return {
      userId: row.user_id,
      githubUserId: Number(row.github_user_id),
      githubLogin: row.github_login,
      accessToken: open(row.access_token_ciphertext),
      accessExpiresAt: date(row.access_token_expires_at),
      refreshToken: row.refresh_token_ciphertext ? open(row.refresh_token_ciphertext) : null,
      refreshExpiresAt: date(row.refresh_token_expires_at),
      refreshCiphertext: row.refresh_token_ciphertext,
      broken: row.broken_at !== null,
      updatedAt: row.updated_at,
    };
  } catch {
    // A rotated CREDENTIALS_ENCRYPTION_KEY: as good as broken, mended by
    // connecting again.
    console.error(`Could not open the GitHub connection of user ${row.user_id}; taking it as broken`);
    return {
      userId: row.user_id,
      githubUserId: Number(row.github_user_id),
      githubLogin: row.github_login,
      accessToken: "",
      accessExpiresAt: null,
      refreshToken: null,
      refreshExpiresAt: null,
      refreshCiphertext: row.refresh_token_ciphertext,
      broken: true,
      updatedAt: row.updated_at,
    };
  }
}

/** The user's connection, or null with none (or before the migration). */
export async function getGithubConnection(userId: string): Promise<GitHubConnection | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_github_connections")
    .select(COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error && notMigrated(error)) return null;
  if (error) throw error;
  return data ? toConnection(data as Row) : null;
}

/** What the settings page shows of it. */
export async function githubConnectionStatus(userId: string): Promise<GitHubConnectionStatus | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_github_connections")
    .select("github_user_id, github_login, access_token_expires_at, refresh_token_expires_at, broken_at, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && notMigrated(error)) return null;
  if (error) throw error;
  if (!data) return null;
  return {
    login: data.github_login,
    githubUserId: Number(data.github_user_id),
    accessExpiresAt: data.access_token_expires_at,
    refreshExpiresAt: data.refresh_token_expires_at,
    broken: data.broken_at !== null,
    updatedAt: data.updated_at,
  };
}

function tokenColumns(tokens: UserTokens) {
  return {
    access_token_ciphertext: seal(tokens.accessToken),
    access_token_expires_at: tokens.accessExpiresAt?.toISOString() ?? null,
    refresh_token_ciphertext: tokens.refreshToken ? seal(tokens.refreshToken) : null,
    refresh_token_expires_at: tokens.refreshExpiresAt?.toISOString() ?? null,
  };
}

/** Keep a new authorization: the user connected, or connected again. */
export async function saveGithubConnection(
  userId: string,
  github: { id: number; login: string },
  tokens: UserTokens,
): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("user_github_connections")
    .upsert(
      {
        user_id: userId,
        github_user_id: github.id,
        github_login: github.login,
        ...tokenColumns(tokens),
        refresh_claimed_until: null,
        broken_at: null,
      },
      { onConflict: "user_id" },
    );
  if (error) throw error;
}

/**
 * Claim the renewal of a user's tokens for `seconds`, so other servers wait
 * for it rather than spend the same refresh token (GitHub takes each once).
 * False when another holds the claim.
 */
export async function claimGithubRefresh(userId: string, seconds: number, now = new Date()): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_github_connections")
    .update({ refresh_claimed_until: new Date(now.getTime() + seconds * 1000).toISOString() })
    .eq("user_id", userId)
    .or(`refresh_claimed_until.is.null,refresh_claimed_until.lt.${now.toISOString()}`)
    .select("user_id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Give up a claim without renewing (GitHub couldn't be asked). */
export async function releaseGithubRefresh(userId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("user_github_connections")
    .update({ refresh_claimed_until: null })
    .eq("user_id", userId);
  if (error) throw error;
}

/** Save renewed tokens, only over the refresh token that renewed them: false
 *  when the row moved on meanwhile (connected again, disconnected). */
export async function saveRefreshedGithubTokens(
  userId: string,
  usedRefreshCiphertext: string,
  tokens: UserTokens,
): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_github_connections")
    .update({ ...tokenColumns(tokens), refresh_claimed_until: null, broken_at: null })
    .eq("user_id", userId)
    .eq("refresh_token_ciphertext", usedRefreshCiphertext)
    .select("user_id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** GitHub won't renew it: only connecting again mends it. Its tokens are
 *  never used again; the account is kept for the settings page to name.
 *  With `usedRefreshCiphertext`, only if that's still the one stored. */
export async function markGithubConnectionBroken(userId: string, usedRefreshCiphertext?: string | null): Promise<void> {
  let query = createSupabaseAdminClient()
    .from("user_github_connections")
    .update({ broken_at: new Date().toISOString(), refresh_claimed_until: null })
    .eq("user_id", userId);
  if (usedRefreshCiphertext) query = query.eq("refresh_token_ciphertext", usedRefreshCiphertext);
  const { error } = await query;
  if (error) throw error;
}

/** The user revoked the App's authorization on GitHub (its webhook): every
 *  connection of that GitHub account is broken. */
export async function markGithubAccountRevoked(githubUserId: number): Promise<number> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_github_connections")
    .update({ broken_at: new Date().toISOString(), refresh_claimed_until: null })
    .eq("github_user_id", githubUserId)
    .select("user_id");
  if (error) throw error;
  return data?.length ?? 0;
}

/** Whether a GitHub account is connected by an Outrunner user other than
 *  `exceptUserId`: its App authorization is then theirs too, and mustn't be
 *  revoked whole. True when that can't be read, so it never is by mistake. */
export async function githubAccountConnectedElsewhere(githubUserId: number, exceptUserId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_github_connections")
    .select("user_id")
    .eq("github_user_id", githubUserId)
    .neq("user_id", exceptUserId)
    .limit(1);
  if (error) {
    console.error("Could not read whether a GitHub account is connected elsewhere; taking it it is", error);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

/** Forget the user's connection (they disconnected). */
export async function deleteGithubConnection(userId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("user_github_connections").delete().eq("user_id", userId);
  if (error && !notMigrated(error)) throw error;
}
