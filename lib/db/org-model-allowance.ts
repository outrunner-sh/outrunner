/**
 * A team org's allowance on Outrunner's models
 * (20261031175000_org_model_allowance.sql): one OpenRouter key of the org's,
 * capped at its plan's allowance, which its members' cloud sessions run
 * Outrunner's models on. As a user's own key is at theirs
 * (lib/db/credentials.ts outrunnerModelKey), with the same rules
 * (lib/billing/model-allowance.ts). A personal org's is its owner's key; an
 * org's connector keeps its own.
 *
 * The server's alone: callers have checked the user is the org's member.
 */

import { entitlementsFor } from "@/lib/billing/entitlements";
import {
  type AllowanceState,
  type AllowanceStore,
  nextAllowance,
  refreshAllowance,
  type RefreshedAllowance,
  refuseUnusable,
} from "@/lib/billing/model-allowance";
import type { PlanId } from "@/lib/billing/plans";
import { open, seal } from "@/lib/crypto/secret-box";
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
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function store(orgId: string): AllowanceStore {
  const supabase = createSupabaseAdminClient();
  return {
    async read() {
      const { data, error } = await supabase
        .from("org_model_allowance")
        .select("key_hash, allowance_period, allowance_plan, allowance_baseline_usd, allowance_limit_usd")
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw error;
      const state: AllowanceState | null =
        data?.allowance_period && data.allowance_plan
          ? {
              period: data.allowance_period,
              plan: data.allowance_plan as PlanId,
              baselineUsd: Number(data.allowance_baseline_usd ?? 0),
              limitUsd: Number(data.allowance_limit_usd ?? 0),
            }
          : null;
      return { hash: data?.key_hash ?? null, state };
    },
    async claim(previous, next) {
      let update = supabase
        .from("org_model_allowance")
        .update({
          allowance_period: next.period,
          allowance_plan: next.plan,
          allowance_baseline_usd: next.baselineUsd,
          allowance_limit_usd: next.limitUsd,
        })
        .eq("org_id", orgId);
      update = previous
        ? update.eq("allowance_period", previous.period).eq("allowance_plan", previous.plan)
        : update.is("allowance_period", null);
      const { data, error } = await update.select("org_id");
      if (error) throw error;
      return data.length > 0;
    },
  };
}

/** Bring the cap on the org's key in line with its plan and period; where it
 *  stands within it. Null with no key yet, or no per-org keys on this server. */
export async function refreshOrgModelAllowance(orgId: string): Promise<RefreshedAllowance | null> {
  if (keySource() !== "per-user") return null;
  return refreshAllowance(store(orgId), {
    usage: keyUsage,
    setLimit: setKeyLimit,
    entitlements: () => entitlementsFor(orgId),
  });
}

/** Where the org's allowance stands, as spent and cap; null where there's
 *  none to show (one shared key, or none). Before its key exists, nothing is
 *  spent of its plan's allowance. */
export async function orgModelAllowance(orgId: string): Promise<Allowance | null> {
  if (keySource() !== "per-user") return null;
  return (await refreshOrgModelAllowance(orgId)) ?? { usedUsd: 0, limitUsd: (await entitlementsFor(orgId)).plan.models.usd };
}

/**
 * The org's key for Outrunner's models, made the first time, capped as a
 * first allowance would be; refused (AllowanceSpentError,
 * ModelKeyDisabledError) when it can't run anything. The shared key where
 * the server has only that.
 */
export async function orgOutrunnerModelKey(orgId: string): Promise<string> {
  const source = keySource();
  if (source === null) throw new OutrunnerModelsUnavailableError();
  if (source === "shared") return sharedApiKey() as string;

  const supabase = createSupabaseAdminClient();
  // The conditional claim needs a row to match.
  const { error: rowError } = await supabase
    .from("org_model_allowance")
    .upsert({ org_id: orgId }, { onConflict: "org_id", ignoreDuplicates: true });
  if (rowError) throw rowError;

  const key = await ensureUserKey(
    {
      async read() {
        const { data, error } = await supabase
          .from("org_model_allowance")
          .select("key_ciphertext, key_hash")
          .eq("org_id", orgId)
          .single();
        if (error) throw error;
        return { ciphertext: data.key_ciphertext, hash: data.key_hash };
      },
      async claim(made) {
        const { data, error } = await supabase
          .from("org_model_allowance")
          .update({ key_ciphertext: made.ciphertext, key_hash: made.hash, key_created_at: made.createdAt })
          .eq("org_id", orgId)
          .is("key_ciphertext", null)
          .select("org_id");
        if (error) throw error;
        return data.length > 0;
      },
    },
    {
      open,
      seal,
      // Labelled by org id only: the OpenRouter dashboard needs no names.
      create: async () =>
        createUserKey(
          `outrunner org ${orgId}`,
          (nextAllowance(await entitlementsFor(orgId), null, 0) as AllowanceState).limitUsd,
        ),
      disable: disableUserKey,
      log: (message, error) => console.error(`${message} (org ${orgId})`, error),
    },
  );
  // As a user's: a spent or disabled key is refused here, with a message the
  // member can act on; a failed refresh leaves OpenRouter's cap to hold.
  const allowance = await refreshOrgModelAllowance(orgId).catch((error: unknown) => {
    console.error(`Could not refresh the model allowance of org ${orgId}`, error);
    return null;
  });
  refuseUnusable(allowance);
  return key;
}

/** The team orgs among `orgIds` with a key of their own, and each one's
 *  stored allowance period (null: none yet): what renewal looks at. */
export async function orgAllowancePeriods(orgIds: readonly string[]): Promise<Map<string, string | null>> {
  const periods = new Map<string, string | null>();
  for (let i = 0; i < orgIds.length; i += 200) {
    const { data, error } = await createSupabaseAdminClient()
      .from("org_model_allowance")
      .select("org_id, allowance_period")
      .in("org_id", orgIds.slice(i, i + 200))
      .not("key_hash", "is", null);
    if (error) throw error;
    for (const row of data) periods.set(row.org_id, row.allowance_period);
  }
  return periods;
}
