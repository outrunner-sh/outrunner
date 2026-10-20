import { redirect } from "next/navigation";

import { ProviderSettingsForm } from "@/components/provider-settings";
import { getOwner } from "@/lib/auth/owner";
import { getProviderKeyStatuses, settleClaudeSlot } from "@/lib/db/credentials";
import { getClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
import { isProviderTab } from "@/lib/settings-links";

export const dynamic = "force-dynamic";

/** Settings → Providers (BYOK): the user's Claude subscription and their own
 *  keys for model providers, a tab each. */
export default async function ProviderSettings({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/providers");
  // An Anthropic API key still in the Claude slot shows here, where it now
  // belongs. A database from before user_provider_keys reads as it was before
  // it (getProviderKeyStatuses); saving a key then says it needs updating.
  await settleClaudeSlot(owner.id);
  const [keys, claude, { tab }] = await Promise.all([
    getProviderKeyStatuses(owner.id),
    getClaudeTokenMeta(owner.id),
    searchParams,
  ]);
  return (
    <ProviderSettingsForm initial={{ keys }} claude={claude} tab={isProviderTab(tab) ? tab : undefined} />
  );
}
