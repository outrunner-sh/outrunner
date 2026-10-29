import { Suspense } from "react";
import { SettingsAlias } from "@/components/settings-alias";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getOrgContext } from "@/lib/orgs/server";
import {
  legacyProviderSettingsHref,
  type SettingsQuery,
} from "@/lib/settings-links";

/** Before settings were scoped, Codex's account card opened the active team
 * org. Preserve that destination for old account links and CLI launchers;
 * explicit personal/API-key links keep their personal destination. */
export default function LegacyProviders({
  searchParams,
}: {
  searchParams: Promise<SettingsQuery>;
}) {
  return (
    <Suspense fallback={null}>
      <LegacyDestination searchParams={searchParams} />
    </Suspense>
  );
}
async function LegacyDestination({
  searchParams,
}: {
  searchParams: Promise<SettingsQuery>;
}) {
  const params = await searchParams;
  const wantsAccount =
    params.tab === "codex" &&
    (params.method === undefined || params.method === "codex-account");
  const org =
    wantsAccount && (await getOwnerSafe())
      ? (await getOrgContext().catch(() => null))?.active
      : null;
  return <SettingsAlias href={legacyProviderSettingsHref(params, org)} />;
}
