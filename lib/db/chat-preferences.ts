/**
 * Each person's chat preferences (user_chat_preferences), through their own
 * client: the defaults (lib/session/chat-preferences.ts) until they change
 * one, and on a database from before the table.
 */

import { type ChatPreferences, DEFAULT_CHAT_PREFERENCES } from "@/lib/session/chat-preferences";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function getChatPreferences(userId: string): Promise<ChatPreferences> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("user_chat_preferences").select("*").eq("user_id", userId).maybeSingle();
  if (error && probeStatus(error) === "missing") return DEFAULT_CHAT_PREFERENCES;
  if (error) throw error;
  return data ? { steerFollowUps: data.steer_follow_ups } : DEFAULT_CHAT_PREFERENCES;
}

export async function saveChatPreferences(userId: string, change: ChatPreferences): Promise<ChatPreferences> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("user_chat_preferences")
    .upsert(
      { user_id: userId, steer_follow_ups: change.steerFollowUps, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return { steerFollowUps: data.steer_follow_ups };
}
