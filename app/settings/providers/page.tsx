import { redirect } from "next/navigation";

import { ProviderSettingsForm } from "@/components/provider-settings";
import { getOwner } from "@/lib/auth/owner";
import { getOpenRouterKeyStatus, type StoredKey } from "@/lib/db/credentials";
import { keySource } from "@/lib/openrouter/keys";
import { probeStatus } from "@/lib/supabase/probe";

export const dynamic = "force-dynamic";

/** Settings → Providers: the user's own keys for the providers their models
 *  run on (OpenRouter's, for Outrunner's models). */
export default async function ProviderSettings() {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/providers");

  // A database from before the key's column shows none saved; saving one then
  // says the database needs updating.
  let openrouter: StoredKey = { connected: false, hint: null, updatedAt: null };
  try {
    openrouter = await getOpenRouterKeyStatus(owner.id);
  } catch (error) {
    if (probeStatus(error as { code?: string }) !== "outdated") throw error;
  }
  return <ProviderSettingsForm initial={{ openrouter, serverModels: keySource() !== null }} />;
}
