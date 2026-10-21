import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ProviderSettingsForm } from "@/components/provider-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwner } from "@/lib/auth/owner";
import { getAgentAuthChoices, getProviderKeyStatuses, settleClaudeSlot } from "@/lib/db/credentials";
import { getClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
import { parseProviderPlace } from "@/lib/settings-links";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

type SearchParams = Promise<{ tab?: string | string[]; method?: string | string[] }>;

/** Settings → Providers (BYOK): how each coding agent signs in, and the
 *  user's own keys for model providers, a tab each. */
export default function ProviderSettings({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<SettingsLoading title="Providers (BYOK)" />}>
      <ProvidersSection searchParams={searchParams} />
    </Suspense>
  );
}

async function ProvidersSection({ searchParams }: { searchParams: SearchParams }) {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/providers");
  // An Anthropic API key still in the Claude slot shows here, where it now
  // belongs. A database from before user_provider_keys reads as it was before
  // it (getProviderKeyStatuses); saving a key then says it needs updating.
  await settleClaudeSlot(owner.id);
  const [keys, choices, claude, { tab, method }] = await Promise.all([
    getProviderKeyStatuses(owner.id),
    getAgentAuthChoices(owner.id),
    getClaudeTokenMeta(owner.id),
    searchParams,
  ]);
  return <ProviderSettingsForm initial={{ keys, choices, claude }} place={parseProviderPlace(tab, method) ?? undefined} />;
}
