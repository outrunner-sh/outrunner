import { redirect } from "next/navigation";

import { ProviderSettingsForm } from "@/components/provider-settings";
import { getOwner } from "@/lib/auth/owner";
import { getProviderKeyStatuses } from "@/lib/db/credentials";

export const dynamic = "force-dynamic";

/** Settings → Providers: the user's own keys for model providers. */
export default async function ProviderSettings() {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/providers");
  // A database from before user_provider_keys reads as it was before it
  // (getProviderKeyStatuses); saving a key then says it needs updating.
  return <ProviderSettingsForm initial={{ keys: await getProviderKeyStatuses(owner.id) }} />;
}
