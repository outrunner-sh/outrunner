"use client";

import Link from "next/link";
import { useState } from "react";

import { InlineMessage } from "@/components/ui/notice";
import type { AutomationSettings } from "@/lib/db/automation-settings";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";

/**
 * Settings → Org → Automations: what the org's automations run on, Outrunner's
 * models or their runner's default model and coding agent. Its admins set
 * it; it saves as it's picked.
 */
export function AutomationRunSettings({ org, initial }: { org: Org; initial: AutomationSettings }) {
  const [settings, setSettings] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = org.role === "admin";
  // A team org's run as its connector, on the org's defaults; a personal
  // org's as its owner, on theirs.
  const own = org.personal ? "Your default model and coding agent" : "The org's default model and coding agent";

  async function save(onHarness: boolean) {
    setSaving(true);
    setError(null);
    try {
      setSettings(
        await requestJson<AutomationSettings>(`/api/orgs/${org.id}/automations/settings`, {
          method: "PUT",
          body: { onHarness },
          has: (s) => typeof s.onHarness === "boolean",
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-2 border-t border-border/60 pt-6">
      <label htmlFor="automations-run-on" className="text-sm font-medium text-foreground">
        Automations run on
      </label>
      {admin ? (
        <select
          id="automations-run-on"
          className="block w-full max-w-sm rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
          disabled={saving}
          value={settings.onHarness ? "harness" : "outrunner"}
          onChange={(event) => void save(event.target.value === "harness")}
        >
          <option value="outrunner">Outrunner&apos;s models</option>
          <option value="harness">{own}</option>
        </select>
      ) : (
        <p className="text-sm text-muted-foreground">{settings.onHarness ? own : "Outrunner's models"}</p>
      )}
      <p className="max-w-prose text-xs text-muted-foreground">
        {own} is Claude Code or Codex on its own sign-in or key, as a new session starts on (
        <Link
          href={org.personal ? "/settings/preferences" : "/settings/org/defaults"}
          className="text-foreground underline underline-offset-2"
        >
          {org.personal ? "Preferences" : "Defaults"}
        </Link>
        ). A run that can&apos;t start on it, say when its sign-in has expired, runs on Outrunner&apos;s models instead
        and says so on the run.
      </p>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {!admin && <p className="text-xs text-muted-foreground">Only the org&apos;s admins change this.</p>}
    </section>
  );
}
