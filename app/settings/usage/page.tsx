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
  UsageCard,
  UsageCardLoading,
} from "@/components/usage-settings";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProviderKey, getProviderKeyStatuses } from "@/lib/db/credentials";
import type { KeyProviderId } from "@/lib/providers/registry";
import { readProviderUsage, type UsageCard as Card, usageCards } from "@/lib/providers/usage";
import { getClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
import { USAGE_SETTINGS_HREF } from "@/lib/settings-links";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Personal provider-account totals, including activity outside Outrunner.
 * Shared model allowance and cloud hours live under Organization → Usage & limits. */
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
  const cards = usageCards({ outrunner: null, claude: claude.connected, keys });
  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Usage</h1>
        <p className="text-sm text-muted-foreground">
          Totals reported by your connected provider accounts. These can include activity outside Outrunner; they are not per-user session analytics. Shared allowance and cloud hours are under Organization → Usage & limits.
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
    case "outrunner": return null;
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

async function KeyFigures({ userId, provider }: { userId: string; provider: KeyProviderId }) {
  const key = await getProviderKey(userId, provider);
  if (!key) return <KeyUnreadable />;
  const read = await readProviderUsage(provider, key);
  return read.ok ? <KeyUsage provider={provider} usage={read.usage} /> : <KeyUsageFailed provider={provider} problem={read.problem} />;
}
