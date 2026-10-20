/**
 * The user's model loadout (Settings → Default models), one row per user in
 * user_model_loadout, reached through the service role only: every function
 * takes an already-verified user id and scopes its query to it.
 */

import { EMPTY_LOADOUT, type ModelLoadout, parseLoadout } from "@/lib/runtime/model-loadout";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The user's loadout; empty when they have none, or before
 *  20261020140000_user_model_loadout.sql is applied. */
export async function getModelLoadout(userId: string): Promise<ModelLoadout> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_model_loadout")
    .select("models, default_model")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return EMPTY_LOADOUT;
  if (error) throw error;
  return data ? parseLoadout({ models: data.models, default: data.default_model }) : EMPTY_LOADOUT;
}

/** Keep `loadout` as the user's, made sound first (parseLoadout). */
export async function setModelLoadout(userId: string, loadout: ModelLoadout): Promise<ModelLoadout> {
  const sound = parseLoadout(loadout);
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("user_model_loadout")
    .upsert({ user_id: userId, models: sound.models, default_model: sound.default }, { onConflict: "user_id" });
  if (error) throw error;
  return sound;
}
