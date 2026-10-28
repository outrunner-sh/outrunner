"use client";

import { useState } from "react";

import { InlineMessage } from "@/components/ui/notice";
import { AUDIT_GROUPS, type AuditEvent, type AuditGroup, auditGroup, describeAudit } from "@/lib/audit/actions";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";

type Page = { events: AuditEvent[]; more: boolean };

/**
 * Settings → Org → Audit log: who changed what in the org, and when, newest
 * first; "Outrunner" for what happened on its own (a plan changing in
 * Stripe, the GitHub App uninstalled on GitHub). Filtered by kind among what's
 * loaded; older events a page at a time.
 */
export function OrgAuditLog({ org, initial }: { org: Org; initial: Page }) {
  const [events, setEvents] = useState(initial.events);
  const [more, setMore] = useState(initial.more);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<AuditGroup | "all">("all");
  const shown = group === "all" ? events : events.filter((e) => auditGroup(e.action) === group);

  async function loadOlder() {
    const last = events.at(-1);
    if (!last) return;
    setLoading(true);
    setError(null);
    try {
      const page = await requestJson<Page>(`/api/orgs/${org.id}/audit?before=${last.id}`, {
        has: (d) => Array.isArray(d.events),
        fallback: "Couldn't load older events.",
      });
      setEvents((current) => [...current, ...page.events]);
      setMore(page.more);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load older events.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Audit log</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {`Every change to ${org.name}'s members, access, keys, settings, GitHub App and billing, by whom and when. Outrunner's own are marked as such.`}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {(["all", ...Object.keys(AUDIT_GROUPS)] as (AuditGroup | "all")[]).map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={group === g}
            onClick={() => setGroup(g)}
            className={
              group === g
                ? "rounded-md border border-foreground/40 bg-muted/50 px-2 py-1 text-xs text-foreground"
                : "rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            }
          >
            {g === "all" ? "All" : AUDIT_GROUPS[g]}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {events.length === 0 ? "Nothing's been recorded yet." : "None of these among what's loaded."}
        </p>
      ) : (
        <ol className="divide-y divide-border/60 border-y border-border/60">
          {shown.map((event) => (
            <li key={event.id} className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
              <span className="min-w-0">
                <span className={event.actorType === "system" ? "text-muted-foreground" : "font-medium text-foreground"}>
                  {event.actorLabel}
                </span>{" "}
                <span className="text-foreground">{describeAudit(event)}</span>
              </span>
              <time
                dateTime={event.createdAt}
                className="shrink-0 text-xs text-muted-foreground"
                suppressHydrationWarning
              >
                {new Date(event.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </time>
            </li>
          ))}
        </ol>
      )}

      {more ? (
        <button
          type="button"
          onClick={() => void loadOlder()}
          disabled={loading}
          className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
        >
          {loading ? "Loading…" : "Older"}
        </button>
      ) : null}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </section>
  );
}
