/**
 * The prompts a user has sent (composer_prompt_history), for the composer to recall.
 * Through the user's own client: the table's policy keeps each user to their
 * own rows. Best effort throughout, as recall is a convenience: a database
 * without the composer table reads as no history until its migrations run.
 */

import { HISTORY_LIMIT, newestDistinct } from "@/lib/session/prompt-history";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** How many rows a user keeps: room for repeats, which recall shows once. */
const KEPT_ROWS = 500;

/** The user's prompts, newest first, each once. */
export async function getPromptHistory(userId: string): Promise<string[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("composer_prompt_history")
    .select("text")
    .eq("owner_id", userId)
    // By id, which only grows: the order the prompts were kept in, and the
    // index's (owner_id, id desc).
    .order("id", { ascending: false })
    .limit(KEPT_ROWS);
  if (error && probeStatus(error) === "missing") return [];
  if (error) throw error;
  return newestDistinct(data.map((row) => row.text)).slice(0, HISTORY_LIMIT);
}

/** Prune on roughly every this many prompts kept (by the global id), not on
 *  each: the send's own write stays one insert. KEPT_ROWS is a soft bound. */
const PRUNE_EVERY = 50;

/** Keep a prompt the user sent; now and then, let the oldest past KEPT_ROWS go. */
export async function addPromptHistory(userId: string, text: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("composer_prompt_history").insert({ owner_id: userId, text }).select("id").single();
  if (error && probeStatus(error) === "missing") return;
  if (error) throw error;
  if (data.id % PRUNE_EVERY !== 0) return;
  // By id, which only grows: a cutoff by time could take more than meant
  // where two prompts share a timestamp.
  const { data: cutoff, error: cutoffError } = await supabase
    .from("composer_prompt_history")
    .select("id")
    .eq("owner_id", userId)
    .order("id", { ascending: false })
    .range(KEPT_ROWS, KEPT_ROWS)
    .maybeSingle();
  if (cutoffError) {
    console.warn(`Prompt history: couldn't find where to prune ${userId}'s`, cutoffError);
    return;
  }
  if (!cutoff) return;
  const { error: deleteError } = await supabase.from("composer_prompt_history").delete().eq("owner_id", userId).lte("id", cutoff.id);
  if (deleteError) console.warn(`Prompt history: couldn't prune ${userId}'s`, deleteError);
}
