/**
 * Each person's notification preferences (notification_preferences): the
 * defaults until they change one (lib/notifications/events.ts).
 */

import {
  DEFAULT_PREFERENCES,
  isNotificationKind,
  type NotificationPreferences,
} from "@/lib/notifications/events";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

type Row = Database["public"]["Tables"]["notification_preferences"]["Row"];

export function toPreferences(row: Row | null | undefined): NotificationPreferences {
  if (!row) return DEFAULT_PREFERENCES;
  return {
    browser: row.browser,
    email: row.email,
    slack: row.slack,
    kinds: (row.kinds ?? []).filter(isNotificationKind),
  };
}

/** The user's own, read as them. */
export async function getPreferences(userId: string): Promise<NotificationPreferences> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return toPreferences(data);
}

/** Save a change to the user's own, as them. */
export async function savePreferences(userId: string, change: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("notification_preferences")
    .upsert({ user_id: userId, ...change, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) throw error;
  return toPreferences(data);
}

/** Several people's, as the server, by user id; the defaults for any with none. */
export async function preferencesOf(userIds: readonly string[]): Promise<Map<string, NotificationPreferences & { digestSentAt: string | null }>> {
  const ids = [...new Set(userIds)];
  const found = new Map<string, NotificationPreferences & { digestSentAt: string | null }>();
  if (ids.length === 0) return found;
  const { data, error } = await createSupabaseAdminClient().from("notification_preferences").select("*").in("user_id", ids);
  if (error) throw error;
  for (const row of data ?? []) found.set(row.user_id, { ...toPreferences(row), digestSentAt: row.digest_sent_at });
  for (const id of ids) if (!found.has(id)) found.set(id, { ...DEFAULT_PREFERENCES, digestSentAt: null });
  return found;
}
