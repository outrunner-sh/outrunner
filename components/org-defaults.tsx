"use client";

import Link from "next/link";
import { useState } from "react";

import { InlineMessage } from "@/components/ui/notice";
import type { OrgDefaults } from "@/lib/db/org-defaults";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";
import { AGENTS, type AgentId } from "@/lib/agents/registry";
import { agentsFor, effortsFor, EFFORT_LABELS, type Effort, type SessionModel } from "@/lib/runtime/session-models";

export type DefaultModelOption = SessionModel & { group: string };

/** A model option's value in the select: its provider and id. */
const valueOf = (m: { provider: string; id: string }) => `${m.provider}\u0000${m.id}`;

/**
 * Settings → Org → Defaults: the model a member's new session starts on, and
 * the size of their new box, for members who haven't chosen their own; and
 * whether sessions are archived when their issue or pull request closes. Its
 * admins set them; each saves as it's picked.
 */
export function OrgDefaultsSettings({
  org,
  initial,
  options,
}: {
  org: Org;
  initial: OrgDefaults;
  options: DefaultModelOption[];
}) {
  const [defaults, setDefaults] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = org.role === "admin";
  const groups = [...new Set(options.map((o) => o.group))];
  const selected = options.find((o) => defaults.defaultModel && valueOf(o) === valueOf(defaults.defaultModel));
  const levels = selected ? effortsFor(selected) : [];
  const shownModel = defaults.defaultModel
    ? (options.find((o) => valueOf(o) === valueOf(defaults.defaultModel!))?.label ?? defaults.defaultModel.id)
    : "Outrunner's default";

  async function save(next: OrgDefaults) {
    setSaving(true);
    setError(null);
    try {
      setDefaults(
        await requestJson<OrgDefaults>(`/api/orgs/${org.id}/defaults`, {
          method: "PUT",
          body: next,
          has: (d) => d.defaultModel !== undefined,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-foreground">Session defaults</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {`For ${org.name}'s members who haven't chosen their own under `}
          <Link href="/settings/models" className="text-foreground underline underline-offset-2">
            Default models
          </Link>
          . A member&apos;s own choice always wins.
        </p>
      </div>

      <div className="space-y-2 border-t border-border/60 pt-6">
        <label htmlFor="org-default-model" className="text-sm font-medium text-foreground">
          Model a new session starts on
        </label>
        {admin ? (
          <select
            id="org-default-model"
            className="block w-full max-w-sm rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
            disabled={saving}
            value={defaults.defaultModel ? valueOf(defaults.defaultModel) : ""}
            onChange={(event) => {
              const picked = options.find((o) => valueOf(o) === event.target.value);
              void save({ ...defaults, defaultModel: picked ? { provider: picked.provider, id: picked.id, ...(picked.defaultEffort ? { effort: picked.defaultEffort } : {}) } : null });
            }}
          >
            <option value="">Outrunner&apos;s default</option>
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {options
                  .filter((o) => o.group === group)
                  .map((o) => (
                    <option key={valueOf(o)} value={valueOf(o)}>
                      {o.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <p className="text-sm text-muted-foreground">{shownModel}</p>
        )}
        <p className="text-xs text-muted-foreground">
          A member who can&apos;t run it (no key for its provider, or no Claude account of their own) starts on
          Outrunner&apos;s default instead.
        </p>
      </div>

      {defaults.defaultModel && <div className="flex flex-wrap gap-4 text-sm">
        {agentsFor(defaults.defaultModel.provider).length > 1 && <label className="flex items-center gap-2">Default harness
          <select aria-label="Organization default harness" className="rounded border bg-background p-2" disabled={!admin || saving}
            value={defaults.defaultModel.agent ?? agentsFor(defaults.defaultModel.provider)[0]}
            onChange={(event) => void save({ ...defaults, defaultModel: { ...defaults.defaultModel!, agent: event.target.value as AgentId } })}>
            {agentsFor(defaults.defaultModel.provider).map((agent) => <option key={agent} value={agent}>{AGENTS[agent].label}</option>)}
          </select>
        </label>}
        {levels.length > 0 && <label className="flex items-center gap-2">Default effort
          <select aria-label="Organization default effort" className="rounded border bg-background p-2" disabled={!admin || saving}
            value={defaults.defaultModel.effort ?? ""}
            onChange={(event) => void save({ ...defaults, defaultModel: { ...defaults.defaultModel!, effort: (event.target.value || undefined) as Effort | undefined } })}>
            <option value="">Model default</option>
            {levels.map((level) => <option key={level} value={level}>{EFFORT_LABELS[level]}</option>)}
          </select>
        </label>}
      </div>}

      <div className="space-y-2 border-t border-border/60 pt-6">
        <label className="flex items-center gap-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            className="size-4 accent-foreground"
            disabled={!admin || saving}
            checked={defaults.archiveOnClose}
            onChange={(event) => void save({ ...defaults, archiveOnClose: event.target.checked })}
          />
          Archive a session when its issue or pull request closes
        </label>
        <p className="text-xs text-muted-foreground">
          A session started from <code>@outrunner</code> on GitHub, or one that opened the pull request, is archived when
          it closes or merges. Archived sessions can be restored.
        </p>
      </div>

      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {!admin && <p className="text-xs text-muted-foreground">Only the org&apos;s admins change its defaults.</p>}
    </section>
  );
}
