import { redirect } from "next/navigation";
import { Suspense } from "react";

import { SettingsLoading } from "@/components/settings-loading";
import {
  BringYourOwnKey,
  CLAUDE_USAGE_LINK,
  ClaudeUsageElsewhere,
  KeyUnreadable,
  KeyUsage,
  KeyUsageElsewhere,
  KeyUsageFailed,
  keyCardTitle,
  keyDashboardLink,
  NoUsage,
  OutrunnerAllowanceUsage,
  OutrunnerUnmetered,
  OutrunnerUsageFailed,
  UsageCard,
  UsageCardLoading,
} from "@/components/usage-settings";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProviderKey, getProviderKeyStatuses, outrunnerModelAllowance } from "@/lib/db/credentials";
import { getOrgContext } from "@/lib/orgs/server";
import { allowanceView } from "@/lib/openrouter/allowance";
import { keySource } from "@/lib/openrouter/keys";
import type { KeyProviderId } from "@/lib/providers/registry";
import { readProviderUsage, type UsageCard as Card, usageCards } from "@/lib/providers/usage";
import { getClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
import { USAGE_SETTINGS_HREF } from "@/lib/settings-links";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/**
 * Settings → Usage: what each source of models has used. Outrunner's models
 * as a share of the plan's allowance; each of the user's own keys as its
 * provider counts it, read live on the key (sessions call providers directly,
 * so there's no other account); and, for a provider or the Claude subscription
 * that gives none, a link to where it's shown.
 */
export default function UsageSettingsPage() {
  return (
    <Suspense fallback={<SettingsLoading title="Usage" />}>
      <UsageSection />
    </Suspense>
  );
}

async function UsageSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect(`/signin?next=${USAGE_SETTINGS_HREF}`);
  const [keys, claude] = await Promise.all([getProviderKeyStatuses(owner.id), getClaudeTokenMeta(owner.id)]);
  const cards = usageCards({ outrunner: keySource(), claude: claude.connected, keys });
  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Usage</h1>
        <p className="text-sm text-muted-foreground">
          What your sessions have used, for each way they run models.
        </p>
      </div>
      {cards.length === 0 ? <NoUsage /> : cards.map((card) => <UsageCardFor key={cardKey(card)} card={card} userId={owner.id} />)}
      {!cards.some((card) => card.kind === "key") && cards.length > 0 && <BringYourOwnKey />}
    </section>
  );
}

function cardKey(card: Card): string {
  return card.kind === "key" ? card.provider : card.kind;
}

function UsageCardFor({ card, userId }: { card: Card; userId: string }) {
  switch (card.kind) {
    case "outrunner":
      return (
        <UsageCard title="Outrunner's models">
          {card.metered ? (
            <Suspense fallback={<UsageCardLoading rows={1} />}>
              <OutrunnerFigures userId={userId} />
            </Suspense>
          ) : (
            <OutrunnerUnmetered />
          )}
        </UsageCard>
      );
    case "claude":
      return (
        <UsageCard title="Claude subscription" link={CLAUDE_USAGE_LINK}>
          <ClaudeUsageElsewhere />
        </UsageCard>
      );
    case "key":
      return (
        <UsageCard title={keyCardTitle(card.provider, card.hint)} link={keyDashboardLink(card.provider)}>
          {card.reads ? (
            <Suspense fallback={<UsageCardLoading rows={card.provider === "openrouter" ? 5 : 1} />}>
              <KeyFigures userId={userId} provider={card.provider} />
            </Suspense>
          ) : (
            <KeyUsageElsewhere provider={card.provider} />
          )}
        </UsageCard>
      );
  }
}

async function OutrunnerFigures({ userId }: { userId: string }) {
  // The org's in a team org they're looking at (billing is the org's).
  const org = (await getOrgContext().catch(() => undefined))?.active;
  const allowance = await outrunnerModelAllowance(userId, org?.id).catch((error: unknown) => {
    console.error("Could not read a user's Outrunner allowance", error);
    return undefined;
  });
  if (allowance === undefined) return <OutrunnerUsageFailed />;
  // Null only with no per-user allowance, which the card already said.
  if (allowance === null) return <OutrunnerUnmetered />;
  return (
    <>
      <OutrunnerAllowanceUsage view={allowanceView(allowance)} />
      {org && !org.personal ? (
        <p className="text-xs text-muted-foreground">{`${org.name}'s, shared by its members' cloud sessions.`}</p>
      ) : null}
    </>
  );
}

async function KeyFigures({ userId, provider }: { userId: string; provider: KeyProviderId }) {
  const key = await getProviderKey(userId, provider);
  if (!key) return <KeyUnreadable />;
  const read = await readProviderUsage(provider, key);
  return read.ok ? <KeyUsage provider={provider} usage={read.usage} /> : <KeyUsageFailed provider={provider} problem={read.problem} />;
}
