import { redirect } from "next/navigation";

import { ProviderSettingsForm } from "@/components/provider-settings";
import { getOwner } from "@/lib/auth/owner";
import { getProviderKeyStatuses, settleClaudeSlot } from "@/lib/db/credentials";

export const dynamic = "force-dynamic";

/** Settings → Providers: the user's own keys for model providers. */
export default async function ProviderSettings() {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/providers");
  // An Anthropic API key still in the Claude slot shows here, where it now
  // belongs. A database from before user_provider_keys reads as it was before
  // it (getProviderKeyStatuses); saving a key then says it needs updating.
  await settleClaudeSlot(owner.id);
  return <ProviderSettingsForm initial={{ keys: await getProviderKeyStatuses(owner.id) }} />;
}
