import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseSessionDefaults, type SessionDefaults } from "@/lib/runtime/session-defaults";

/** The signed-in user's defaults for new sessions (Settings → Models). */
export async function getSessionDefaults(): Promise<SessionDefaults> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return parseSessionDefaults(user?.user_metadata?.session_defaults);
}

/** Save the signed-in user's defaults; what is saved is what parses back. */
export async function saveSessionDefaults(raw: unknown): Promise<SessionDefaults> {
  const defaults = parseSessionDefaults(raw);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ data: { session_defaults: defaults } });
  if (error) throw error;
  return defaults;
}
