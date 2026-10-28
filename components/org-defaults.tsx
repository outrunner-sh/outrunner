"use client";

import Link from "next/link";
import { useState } from "react";

import { InlineMessage } from "@/components/ui/notice";
import type { OrgDefaults } from "@/lib/db/org-defaults";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";
import { BOX_SIZES, boxSize } from "@/lib/runtime/box-sizes";
import type { ModelProvider } from "@/lib/runtime/session-models";

export type DefaultModelOption = { provider: ModelProvider; id: string; label: string; group: string };

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
        <h1 className="text-lg font-semibold text-foreground">Defaults</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {`For ${org.name}'s members who haven't chosen their own under `}
          <Link href="/settings/models" className="text-foreground underline underline-offset-2">
            Default models
          </Link>
          {" and "}
          <Link href="/settings/sandbox" className="text-foreground underline underline-offset-2">
            Sandbox
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
            className="block w-full max-w-sm rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            disabled={saving}
            value={defaults.defaultModel ? valueOf(defaults.defaultModel) : ""}
            onChange={(event) => {
              const picked = options.find((o) => valueOf(o) === event.target.value);
              void save({ ...defaults, defaultModel: picked ? { provider: picked.provider, id: picked.id } : null });
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

      <div className="space-y-2 border-t border-border/60 pt-6">
        <label htmlFor="org-box-size" className="text-sm font-medium text-foreground">
          Size of a new box
        </label>
        {admin ? (
          <select
            id="org-box-size"
            className="block w-full max-w-sm rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            disabled={saving}
            value={defaults.boxSize ?? ""}
            onChange={(event) => {
              const id = BOX_SIZES.find((size) => size.id === event.target.value)?.id ?? null;
              void save({ ...defaults, boxSize: id });
            }}
          >
            <option value="">Outrunner&apos;s default</option>
            {BOX_SIZES.map((size) => (
              <option key={size.id} value={size.id}>
                {`${size.label} · ${size.cpu} CPU, ${size.memoryGb} GB`}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-muted-foreground">
            {defaults.boxSize ? boxSize(defaults.boxSize).label : "Outrunner's default"}
          </p>
        )}
        <p className="text-xs text-muted-foreground">Never beyond what each member&apos;s plan allows.</p>
      </div>

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
