/**
 * Secrets beyond a project's (20261117110000_team_and_personal_secrets.sql):
 * an org's ("team"), which every member's sessions in it get, and a person's
 * own, which their sessions get in any org; each for some repositories, or
 * all. Values are sealed (lib/crypto/secret-box.ts) and only ever opened for
 * a session's setup (sessionScopedSecrets). Service role only: who may is the
 * caller's to check (lib/api/cursor-environments.deps.ts).
 */

import { open, seal } from "@/lib/crypto/secret-box";
import type { ScopedSecrets, ScopedValue } from "@/lib/session/session-overrides";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type SecretType = "runtime_secret" | "environment_variable";

/** A secret as it's listed: never its value. */
export type ScopedSecret = {
  id: string;
  name: string;
  type: SecretType;
  /** Repositories' full names it's for; none is all. */
  repos: string[];
  createdAt: string;
  updatedAt: string;
};

export type SecretScope = { kind: "team"; orgId: string } | { kind: "user"; userId: string };

const COLUMNS = "id, name, type, repos, created_at, updated_at";

function table(scope: SecretScope) {
  const db = createSupabaseAdminClient();
  return scope.kind === "team"
    ? { db, name: "org_secrets" as const, key: "org_id", value: scope.orgId }
    : { db, name: "user_secrets" as const, key: "user_id", value: scope.userId };
}

function secretOf(row: Record<string, unknown>): ScopedSecret {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as SecretType,
    repos: (row.repos as string[] | null) ?? [],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function listScopedSecrets(scope: SecretScope): Promise<ScopedSecret[]> {
  const t = table(scope);
  const { data, error } = await t.db.from(t.name).select(COLUMNS).eq(t.key, t.value).order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => secretOf(row as Record<string, unknown>));
}

/** Set one: made, or its value (and type and repositories, where given)
 *  changed in place. Answers it, and whether it was made. */
export async function putScopedSecret(
  scope: SecretScope,
  name: string,
  input: { value: string; type?: SecretType; repos?: string[]; createdBy?: string },
): Promise<{ secret: ScopedSecret; created: boolean }> {
  const t = table(scope);
  const { data: existing, error: readError } = await t.db.from(t.name).select("id").eq(t.key, t.value).eq("name", name).maybeSingle();
  if (readError) throw readError;
  const fields = {
    value_ciphertext: seal(input.value),
    ...(input.type && { type: input.type }),
    ...(input.repos && { repos: input.repos }),
  };
  if (existing) {
    const { data, error } = await t.db.from(t.name).update(fields).eq("id", existing.id).select(COLUMNS).single();
    if (error) throw error;
    return { secret: secretOf(data as Record<string, unknown>), created: false };
  }
  const { data, error } = await t.db
    .from(t.name)
    .insert({
      [t.key]: t.value,
      name,
      ...fields,
      ...(scope.kind === "team" && input.createdBy && { created_by: input.createdBy }),
    } as never)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return { secret: secretOf(data as Record<string, unknown>), created: true };
}

/** Remove one; whether there was one. */
export async function deleteScopedSecret(scope: SecretScope, name: string): Promise<boolean> {
  const t = table(scope);
  const { data, error } = await t.db.from(t.name).delete().eq(t.key, t.value).eq("name", name).select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function opened(scope: SecretScope): Promise<ScopedValue[]> {
  const t = table(scope);
  const { data, error } = await t.db.from(t.name).select("name, repos, value_ciphertext").eq(t.key, t.value);
  // Before the migration that adds them, there are none.
  if (error && probeStatus(error) === "missing") return [];
  if (error) throw error;
  const values: ScopedValue[] = [];
  for (const row of data ?? []) {
    try {
      values.push({ name: row.name as string, value: open(row.value_ciphertext as string), repos: (row.repos as string[] | null) ?? [] });
    } catch (cause) {
      console.error(`A ${scope.kind} secret (${row.name as string}) couldn't be opened; the session starts without it`, cause);
    }
  }
  return values;
}

/** The org's and the person's secrets, opened, each with the repositories
 *  it's for: the setup keeps those of its session's (scopedEnvFor). */
export async function sessionScopedSecrets(orgId: string | null, userId: string): Promise<ScopedSecrets> {
  const [team, personal] = await Promise.all([orgId ? opened({ kind: "team", orgId }) : [], opened({ kind: "user", userId })]);
  return { team, personal };
}
