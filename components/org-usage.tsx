"use client";

import { PageHeader } from "@/components/page-layout";

import { useState } from "react";

import { InlineMessage } from "@/components/ui/notice";
import type { OrgHours } from "@/lib/billing/org-hours";
import { ALERT_THRESHOLDS, type AlertThreshold, type UsageControls } from "@/lib/billing/usage-controls";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";

type Usage = { controls: UsageControls; hours: OrgHours };

const LIMITS = [null, 90, 80, 50, 25] as const;

/**
 * Settings → Org → Usage: the org's cloud hours this period against its
 * plan's, and its admins' controls: a limit at a share of them (no box
 * starts past it, and running ones pause where the backend can), and email
 * alerts as they're used.
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
  const [usage, setUsage] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = org.role === "admin";
  const { controls, hours } = usage;
  const unlimited = hours.planHours === null;
  const share =
    hours.planHours !== null && hours.planHours > 0 ? Math.min(100, (hours.used / hours.planHours) * 100) : 0;
  const capShare =
    hours.planHours !== null && hours.planHours > 0 && hours.cap !== null ? (hours.cap / hours.planHours) * 100 : 100;

  async function save(next: UsageControls) {
    setSaving(true);
    setError(null);
    try {
      setUsage(
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
          {`${org.name}'s cloud hours this period, shared by all its members' sessions, against its ${hours.planLabel} plan's.`}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-foreground">
            {unlimited
              ? `${hours.used} hours used · Unlimited cloud hours`
              : `${hours.used} of ${hours.planHours} hours`}
          </span>
          <span className="text-xs text-muted-foreground" suppressHydrationWarning>
            {`Resets ${new Date(hours.periodEnd).toLocaleDateString(undefined, { dateStyle: "medium" })}`}
          </span>
        </div>
        {!unlimited && (
          <div className="relative h-2 rounded-full bg-muted" aria-hidden>
            <div className="h-2 rounded-full bg-foreground/70" style={{ width: `${share}%` }} />
            {controls.limitPercent !== null && controls.limitPercent < 100 ? (
              <div className="absolute top-[-3px] h-[14px] w-px bg-destructive" style={{ left: `${capShare}%` }} />
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-border/60 pt-6">
        <label htmlFor="org-usage-limit" className="text-sm font-medium text-foreground">
          Usage limit
        </label>
        {unlimited ? (
          <p className="text-sm text-muted-foreground">Unlimited cloud hours on your {hours.planLabel} plan.</p>
        ) : admin ? (
          <select
            id="org-usage-limit"
            className="block w-full max-w-sm rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
            disabled={saving}
            value={controls.limitPercent ?? ""}
            onChange={(event) =>
              void save({ ...controls, limitPercent: event.target.value ? Number(event.target.value) : null })
            }
          >
            {LIMITS.map((limit) => (
              <option key={limit ?? "none"} value={limit ?? ""}>
                {limit === null
                  ? `None: all ${hours.planHours} of the plan's hours`
                  : `${limit}% of the plan's hours (${(hours.planHours! * limit) / 100})`}
              </option>
            ))}
            {controls.limitPercent !== null && !LIMITS.includes(controls.limitPercent as (typeof LIMITS)[number]) ? (
              <option value={controls.limitPercent}>{`${controls.limitPercent}%`}</option>
            ) : null}
          </select>
        ) : (
          <p className="text-sm text-muted-foreground">
            {controls.limitPercent === null ? "None" : `${controls.limitPercent}% of the plan's hours`}
          </p>
        )}
        {!unlimited && (
          <p className="text-xs text-muted-foreground">
            {pausesBoxes
              ? "At the limit, no new cloud session starts, and running ones pause within a couple of minutes."
              : "At the limit, no new cloud session starts; running ones carry on."}
          </p>
        )}
      </div>

      {!unlimited && (
        <fieldset className="space-y-2 border-t border-border/60 pt-6">
          <legend className="text-sm font-medium text-foreground">Email the admins at</legend>
          <div className="flex gap-4">
            {ALERT_THRESHOLDS.map((threshold) => (
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
          <p className="text-xs text-muted-foreground">Of the plan&apos;s hours, once each per period.</p>
        </fieldset>
      )}

      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {!admin && <p className="text-xs text-muted-foreground">Only the org&apos;s admins change these.</p>}
    </section>
  );
}
