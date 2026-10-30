import { PageHeader } from "@/components/page-layout";

import Link from "next/link";
import { ArrowLeft, KeyRound, Vault } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { SecretSyncConnect } from "@/components/secret-sync-connect";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { orgSecretIntegrations } from "@/lib/db/secret-sync";
import { getOrgContext } from "@/lib/orgs/server";
import { isSecretProvider, PROVIDER_LABELS, type SecretProvider } from "@/lib/secret-sync/rules";

type PageProps = { params: Promise<{ provider: string }> };

/**
 * Settings → Org → Integrations → Doppler or Infisical
 * (docs/secret-sync.md): what the org is connected to and, for an admin, the
 * form that connects it. Projects are linked to it from their own page.
 */
export default async function OrgSecretSyncSettings({ params }: PageProps) {
  const { provider } = await params;
  if (!isSecretProvider(provider)) notFound();
  return (
    <Suspense fallback={<SettingsLoading title={PROVIDER_LABELS[provider]} />}>
      <SecretSyncSection provider={provider} />
    </Suspense>
  );
}

const ABOUT: Record<SecretProvider, string> = {
  doppler:
    "New sessions of a linked project get the Doppler config's secrets as environment variables, fetched as each session starts. A project's own variables win a name.",
  infisical:
    "New sessions of a linked project get the Infisical environment's secrets as environment variables, fetched as each session starts, and an infisical CLI signed in as the machine identity. A project's own variables win a name.",
};

async function SecretSyncSection({ provider }: { provider: SecretProvider }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect(`/signin?next=/settings/org/integrations/${provider}`);
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  const integrations = org ? await orgSecretIntegrations(org.id).catch(() => null) : null;
  const Icon = provider === "doppler" ? KeyRound : Vault;

  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <Link href="/settings/org/integrations" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Integrations
        </Link>
        <div className="flex items-center gap-3">
          <Icon className="size-7" />
          <div>
            <PageHeader title={PROVIDER_LABELS[provider]} />
            <p className="text-sm text-muted-foreground">{ABOUT[provider]}</p>
          </div>
        </div>
      </div>
      {!org || !integrations ? (
        <p className="text-sm text-muted-foreground">Couldn&apos;t load {PROVIDER_LABELS[provider]}. Reload the page to try again.</p>
      ) : (
        <SecretSyncConnect orgId={org.id} provider={provider} admin={org.role === "admin"} initial={integrations[provider]} />
      )}
    </section>
  );
}
