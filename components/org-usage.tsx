"use client";

import { PageHeader } from "@/components/page-layout";

import { useState } from "react";

import { InlineMessage } from "@/components/ui/notice";
import type { OrgUsage } from "@/lib/billing/org-standing";
import { formatUsd } from "@/lib/billing/usage";
import type { AlertThreshold, UsageControls } from "@/lib/billing/usage-controls";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";

type Usage = { controls: UsageControls; usage: OrgUsage };

/** The limits offered, as multiples of the plan's included usage. */
const LIMIT_MULTIPLES = [1, 1.5, 2, 3, 5] as const;

/**
 * Settings → Org → Usage: the org's cloud usage this period against what its
 * plan includes, any overage, and its admins' controls: a dollar limit on a
 * plan that bills overage (no box starts past it, and running ones pause
 * where the backend can), and email alerts as usage grows.
 */
export function OrgUsageSettings({
  org,
  initial,
  pausesBoxes,
}: {
  org: Org;
  initial: Usage;
  /** Whether running boxes pause at the limit here (lib/billing/usage-sweep.ts). */
  pausesBoxes: boolean;
}) {
  const [state, setState] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = org.role === "admin";
  const { controls, usage } = state;
  const cap = usage.includedCapCents;
  const share = cap > 0 ? Math.min(100, (usage.includedCents / cap) * 100) : 0;
  const includedUsd = cap / 100;
  const limits = LIMIT_MULTIPLES.map((multiple) => includedUsd * multiple);

  async function save(next: UsageControls) {
    setSaving(true);
    setError(null);
    try {
      setState(
        await requestJson<Usage>(`/api/orgs/${org.id}/usage`, {
          method: "PUT",
          body: next,
          has: (d) => d.controls !== undefined,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  const toggle = (threshold: AlertThreshold) => {
    const on = controls.alertThresholds.includes(threshold);
    void save({
      ...controls,
      alertThresholds: on
        ? controls.alertThresholds.filter((t) => t !== threshold)
        : [...controls.alertThresholds, threshold].sort((a, b) => a - b),
    });
  };

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <PageHeader title="Usage &amp; limits" />
        <p className="max-w-prose text-sm text-muted-foreground">
          {usage.periodEnd === null
            ? `${org.name}'s cloud usage on the free trial, shared by all its members' sessions.`
            : `${org.name}'s cloud usage this period, shared by all its members' sessions, against its ${usage.planLabel} plan's included usage.`}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-foreground">{`${formatUsd(usage.includedCents)} of ${formatUsd(cap)} included`}</span>
          <span className="text-xs text-muted-foreground" suppressHydrationWarning>
            {usage.periodEnd === null
              ? "Once, doesn't reset"
              : `Resets ${new Date(usage.periodEnd).toLocaleDateString(undefined, { dateStyle: "medium" })}`}
          </span>
        </div>
        <div className="h-2 rounded-full bg-muted" aria-hidden>
          <div className="h-2 rounded-full bg-foreground/70" style={{ width: `${share}%` }} />
        </div>
        {usage.overage && usage.overageCents > 0 ? (
          <p className="text-sm text-foreground">{`${formatUsd(usage.overageCents)} overage, billed at 1.5x the included rate`}</p>
        ) : null}
        {usage.state === "unpaid" ? (
          <InlineMessage tone="error">
            An overage payment failed: no new cloud session starts until it&apos;s paid in Settings → Org → Billing.
          </InlineMessage>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-border/60 pt-6">
        <label htmlFor="org-usage-limit" className="text-sm font-medium text-foreground">
          Usage limit
        </label>
        {!usage.takesLimit ? (
          <p className="text-sm text-muted-foreground">
            {usage.periodEnd === null
              ? "The trial stops at its included usage. Subscribe to keep going past it."
              : `The ${usage.planLabel} plan stops at its included usage.`}
          </p>
        ) : admin ? (
          <select
            id="org-usage-limit"
            className="block w-full max-w-sm rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
            disabled={saving}
            value={controls.limitUsd ?? ""}
            onChange={(event) =>
              void save({ ...controls, limitUsd: event.target.value ? Number(event.target.value) : null })
            }
          >
            <option value="">None: overage is billed as it comes</option>
            {limits.map((limit, i) => (
              <option key={limit} value={limit}>
                {LIMIT_MULTIPLES[i] === 1
                  ? `${formatUsd(limit * 100)}: the included usage, no overage`
                  : `${formatUsd(limit * 100)} (${LIMIT_MULTIPLES[i]}x the included)`}
              </option>
            ))}
            {controls.limitUsd !== null && !limits.includes(controls.limitUsd) ? (
              <option value={controls.limitUsd}>{formatUsd(controls.limitUsd * 100)}</option>
            ) : null}
          </select>
        ) : (
          <p className="text-sm text-muted-foreground">
            {usage.limitCents === null ? "None" : formatUsd(usage.limitCents)}
          </p>
        )}
        {usage.takesLimit && controls.limitUsd !== null && usage.limitCents !== null && usage.limitCents > controls.limitUsd * 100 ? (
          <p className="text-xs text-muted-foreground">
            {`The saved ${formatUsd(controls.limitUsd * 100)} is below what the plan includes, so the limit is ${formatUsd(usage.limitCents)}.`}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {`At ${usage.takesLimit ? "the limit" : "it"}, no new cloud session starts${
            pausesBoxes ? ", and running ones pause within a couple of minutes." : "; running ones carry on."
          }`}
        </p>
      </div>

      <fieldset className="space-y-2 border-t border-border/60 pt-6">
        <legend className="text-sm font-medium text-foreground">Email the admins at</legend>
        <div className="flex gap-4">
          {usage.alertThresholds.map((threshold) => (
            <label key={threshold} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={controls.alertThresholds.includes(threshold)}
                disabled={!admin || saving}
                onChange={() => toggle(threshold)}
              />
              {`${threshold}%`}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Of the included usage, once each period.</p>
      </fieldset>

      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {!admin && <p className="text-xs text-muted-foreground">Only the org&apos;s admins change these.</p>}
    </section>
  );
}
