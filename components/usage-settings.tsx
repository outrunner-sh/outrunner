import Link from "next/link";

import { AllowanceBar } from "@/components/allowance-bar";
import { DetailRow, Details, SectionHeader } from "@/components/settings-details";
import { SkeletonRows } from "@/components/ui/skeleton-swap";
import type { AllowanceView } from "@/lib/openrouter/allowance";
import { type KeyProviderId, PROVIDERS, usageDashboard } from "@/lib/providers/registry";
import type { ProviderUsage, UsageProblem } from "@/lib/providers/usage";
import { PROVIDERS_SETTINGS_HREF, providerSettingsHref } from "@/lib/settings-links";

/**
 * Settings → Usage's cards (app/settings/usage/page.tsx), one per source of
 * the models sessions run on. Nothing here reads anything: the page streams
 * each card's figures in, so a slow provider holds up only its own card.
 */

/** Where Claude shows a subscription's usage: it gives apps none. */
const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

/** A card: a header naming the source, with its dashboard on the right. */
export function UsageCard({
  title,
  link,
  children,
}: {
  title: string;
  link?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader title={title} link={link} />
      {children}
    </section>
  );
}

/** A card's figures while they stream in: rows at the figures' own height. */
export function UsageCardLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy className="rounded-lg border border-border/60 px-4">
      <SkeletonRows rows={rows} rowHeight={41} />
    </div>
  );
}

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warning" }) {
  return <p className={tone === "warning" ? "text-sm text-warning" : "text-sm text-muted-foreground"}>{children}</p>;
}

function SettingsLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-foreground underline underline-offset-4">
      {children}
    </Link>
  );
}

/** The title of a key's card: whose key, and its last 4. */
export function keyCardTitle(provider: KeyProviderId, hint: string | null): string {
  // OpenAI's key is Codex's, and is saved under it.
  const name = provider === "openai" ? "Codex · OpenAI key" : `${PROVIDERS[provider].label} · your key`;
  return hint ? `${name} ····${hint}` : name;
}

export function keyDashboardLink(provider: KeyProviderId) {
  return { href: usageDashboard(provider), label: `${PROVIDERS[provider].label} dashboard` };
}

// Outrunner's models -------------------------------------------------------

/** The allowance on Outrunner's models: how much is used, as a share. */
export function OutrunnerAllowanceUsage({ view }: { view: AllowanceView }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/60 px-4 py-3">
        <AllowanceBar view={view} label="Used this period" />
      </div>
      {view.state === "out" ? (
        <Note tone="warning">
          You&apos;ve used your included usage. <SettingsLink href="/settings/billing">Upgrade your plan</SettingsLink>,{" "}
          <SettingsLink href={providerSettingsHref("claude")}>connect Claude</SettingsLink>, or{" "}
          <SettingsLink href={PROVIDERS_SETTINGS_HREF}>add a key of your own</SettingsLink> to keep going.
        </Note>
      ) : (
        <Note>Included with your plan. Sessions on Outrunner&apos;s models draw from it.</Note>
      )}
    </div>
  );
}

/** Where the server runs Outrunner's models on one shared key: nobody's use
 *  of it is counted. */
export function OutrunnerUnmetered() {
  return <Note>Outrunner&apos;s models run on this server&apos;s shared key, so use isn&apos;t counted per account.</Note>;
}

export function OutrunnerUsageFailed() {
  return <Note tone="warning">Couldn&apos;t read your usage right now. Try again in a minute.</Note>;
}

// A key of the user's own ---------------------------------------------------

/** What a key's provider reported. */
export function KeyUsage({ provider, usage }: { provider: KeyProviderId; usage: ProviderUsage }) {
  const { label } = PROVIDERS[provider];
  if (usage.kind === "spend") {
    return (
      <div className="space-y-3">
        <Details>
          <DetailRow term="Today">{money(usage.dailyUsd)}</DetailRow>
          <DetailRow term="This week">{money(usage.weeklyUsd)}</DetailRow>
          <DetailRow term="This month">{money(usage.monthlyUsd)}</DetailRow>
          <DetailRow term="All time">{money(usage.usedUsd)}</DetailRow>
          <DetailRow term="Limit">
            {usage.limitUsd === null
              ? "No limit"
              : `${money(usage.limitUsd)}${usage.remainingUsd === null ? "" : ` · ${money(usage.remainingUsd)} left`}`}
          </DetailRow>
        </Details>
        <Note>Spent on this key, as {label} counts it, by UTC day, week and month.</Note>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <Details>
        {usage.balances.length === 0 ? (
          <DetailRow term="Balance">None</DetailRow>
        ) : (
          usage.balances.map((b) => (
            <DetailRow key={b.currency} term="Balance">
              {money(b.amount, b.currency)}
            </DetailRow>
          ))
        )}
      </Details>
      {usage.available ? (
        <Note>Credit left on your {label} account. {label} reports a balance, not what each key spent.</Note>
      ) : (
        <Note tone="warning">
          Your {label} account is out of credit: sessions on this key fail until you top it up.
        </Note>
      )}
    </div>
  );
}

const PROBLEM: Record<UsageProblem, (label: string) => React.ReactNode> = {
  refused: (label) => (
    <>
      {label} no longer accepts this key. <SettingsLink href={PROVIDERS_SETTINGS_HREF}>Save a new one</SettingsLink>.
    </>
  ),
  "rate-limited": (label) => `${label} is limiting requests on this key right now. Try again in a minute.`,
  unavailable: (label) => `Couldn't reach ${label} right now. Try again later.`,
};

export function KeyUsageFailed({ provider, problem }: { provider: KeyProviderId; problem: UsageProblem }) {
  return <Note tone="warning">{PROBLEM[problem](PROVIDERS[provider].label)}</Note>;
}

/** A saved key that no longer decrypts (the server's encryption key changed). */
export function KeyUnreadable() {
  return (
    <Note tone="warning">
      This key can&apos;t be read anymore. <SettingsLink href={PROVIDERS_SETTINGS_HREF}>Save it again</SettingsLink>.
    </Note>
  );
}

/** A provider that gives no usage for an ordinary key. */
export function KeyUsageElsewhere({ provider }: { provider: KeyProviderId }) {
  const { label } = PROVIDERS[provider];
  return <Note>{label} doesn&apos;t share usage with an ordinary API key. See it on your {label} dashboard.</Note>;
}

// The Claude subscription ---------------------------------------------------

export const CLAUDE_USAGE_LINK = { href: CLAUDE_USAGE_URL, label: "claude.ai usage" };

export function ClaudeUsageElsewhere() {
  return <Note>Claude shows your subscription&apos;s usage and limits only on claude.ai.</Note>;
}

// ---------------------------------------------------------------------------

/** No usage to show: no models of Outrunner's, and nothing of the user's. */
export function NoUsage() {
  return (
    <Note>
      Nothing to show yet. <SettingsLink href={PROVIDERS_SETTINGS_HREF}>Connect Claude or add a key</SettingsLink> to
      start a session.
    </Note>
  );
}

/** Under the cards when the user has no keys of their own. */
export function BringYourOwnKey() {
  return (
    <Note>
      Using your own provider account? <SettingsLink href={PROVIDERS_SETTINGS_HREF}>Add its key</SettingsLink> and
      what it spends shows here.
    </Note>
  );
}

/** "$1.25"; "<$0.01" for a start, so it isn't "$0.00"; "—" for a figure the
 *  provider didn't give. */
function money(amount: number | null, currency = "USD"): string {
  if (amount === null) return "—";
  if (amount > 0 && amount < 0.01) return `<${money(0.01, currency)}`;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    // A currency code Intl doesn't know.
    return `${amount.toFixed(2)} ${currency}`;
  }
}
