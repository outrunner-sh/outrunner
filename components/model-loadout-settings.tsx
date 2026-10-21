"use client";

import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useRef, useState } from "react";

import { AgentIcon, ProviderIcon } from "@/components/brand-icons";
import { EffortPicker } from "@/components/effort-meter";
import { forgetOutrunnerModels } from "@/lib/desktop/local-runtime";
import { requestJson } from "@/lib/http/request-json";
import {
  LOADOUT_MAX,
  type LoadoutEntry,
  loadoutModels,
  type ModelLoadout,
  loadoutEffort,
  moveEntry,
  sameEntry,
  setEntryEffort,
  toggleEntry,
} from "@/lib/runtime/model-loadout";
import { type ModelGroup, type ModelProvider, type SessionModel, takesEffort } from "@/lib/runtime/session-models";
import { cn } from "@/lib/utils";

/** A model's mark: its agent's for Claude Code's and Codex's own, its
 *  provider's for one on a key. */
function ModelIcon({ provider }: { provider: ModelProvider }) {
  if (provider === "claude" || provider === "codex") return <AgentIcon agent={provider} />;
  return <ProviderIcon provider={provider === "outrunner" ? "openrouter" : provider} />;
}

/** What a group's column is called: its agent, for Claude Code's and
 *  Codex's own models. */
function columnLabel(group: ModelGroup): string {
  return group.provider === "claude" ? "Claude Code" : group.label;
}

/**
 * Settings → Default models: the user's loadout, the models the chat picker
 * shows first and the one a new session starts on (lib/runtime/model-loadout.ts).
 * Every model the menu offers is a column below, to pick from. Each change is
 * saved as it's made (PUT /api/settings/models).
 */
export function ModelLoadoutSettings({ groups, initial }: { groups: ModelGroup[]; initial: ModelLoadout }) {
  const [loadout, setLoadout] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // Saves go out one at a time, in the order the changes were made, so the
  // last one made is the one kept: two sent at once could land the other way.
  const queue = useRef<Promise<void>>(Promise.resolve());
  // The latest change: only its save's answer, or failure, updates the page.
  const latest = useRef(0);
  // What the server last kept, to go back to if a save fails.
  const saved = useRef(initial);

  function change(next: ModelLoadout) {
    setLoadout(next);
    setError(null);
    const mine = ++latest.current;
    queue.current = queue.current.then(async () => {
      try {
        const data = await requestJson<ModelLoadout>("/api/settings/models", {
          method: "PUT",
          body: next,
          has: (d) => d.models !== undefined,
          fallback: "Couldn't save that. Try again.",
        });
        saved.current = { models: data.models, default: data.default };
        if (latest.current === mine) setLoadout(saved.current);
        // The picker's menu carries the loadout: let it ask again.
        forgetOutrunnerModels();
      } catch (e) {
        if (latest.current !== mine) return;
        setLoadout(saved.current);
        setError(e instanceof Error ? e.message : "Couldn't save that.");
      }
    });
  }

  const picked = loadoutModels(loadout, groups);
  // Kept, but not offered here now (its provider's key removed): still
  // listed, so it can be taken out.
  const hidden = loadout.models.filter((entry) => !picked.some((m) => sameEntry(m, entry)));
  const has = (m: SessionModel) => loadout.models.some((entry) => sameEntry(entry, m));
  const full = loadout.models.length >= LOADOUT_MAX;
  // The agents' own models first, then the menu's others in its order.
  const columns = [
    ...groups.filter((g) => g.provider === "claude" || g.provider === "codex"),
    ...groups.filter((g) => g.provider !== "claude" && g.provider !== "codex"),
  ];

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Default models</h1>
        <p className="text-sm text-muted-foreground">
          Choose the models the chat picker shows, and the one new sessions start on.
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium text-foreground">Loadout</h2>
          <p className="text-xs text-muted-foreground">
            Click a model to make it the default, and its bars to set how hard it thinks. Up to {LOADOUT_MAX}; search
            in the picker finds the rest.
          </p>
        </div>
        {picked.length === 0 && hidden.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
            None chosen: the picker lists every model. Pick some below.
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60">
            {picked.map((m, i) => {
              const isDefault = sameEntry(loadout.default, m);
              return (
                <li key={`${m.provider}:${m.id}`} className="group relative bg-background">
                  <button
                    type="button"
                    onClick={() => change({ ...loadout, default: { provider: m.provider, id: m.id } })}
                    aria-pressed={isDefault}
                    title={isDefault ? "The default" : "Make it the default"}
                    className={cn(
                      "flex h-24 w-full cursor-pointer flex-col justify-between p-3 text-left transition-colors hover:bg-muted/30",
                      takesEffort(m) && "h-28 pb-9",
                    )}
                  >
                    <span className="flex items-start justify-between">
                      <ModelIcon provider={m.provider} />
                      {isDefault ? (
                        <span className="rounded border border-border/60 bg-muted/60 px-1.5 font-mono text-[10px] tracking-wide text-muted-foreground">
                          DEFAULT
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate font-mono text-[13px] text-foreground">{m.label}</span>
                  </button>
                  {/* Beside the card's button, not in it: a button can't hold another. */}
                  {takesEffort(m) ? (
                    <span className="absolute bottom-3 left-3">
                      <EffortPicker
                        effort={loadoutEffort(loadout, m) ?? null}
                        onChange={(effort) => change(setEntryEffort(loadout, m, effort))}
                        label={`${m.label} effort`}
                      />
                    </span>
                  ) : null}
                  <span className="absolute right-1.5 bottom-1.5 hidden gap-0.5 group-focus-within:flex group-hover:flex">
                    <IconButton label={`Move ${m.label} earlier`} disabled={i === 0} onClick={() => change(moveEntry(loadout, m, -1, picked))}>
                      <ChevronLeft />
                    </IconButton>
                    <IconButton
                      label={`Move ${m.label} later`}
                      disabled={i === picked.length - 1}
                      onClick={() => change(moveEntry(loadout, m, 1, picked))}
                    >
                      <ChevronRight />
                    </IconButton>
                    <IconButton label={`Remove ${m.label}`} onClick={() => change(toggleEntry(loadout, m))}>
                      <X />
                    </IconButton>
                  </span>
                </li>
              );
            })}
            {hidden.map((entry) => (
              <HiddenEntry key={`${entry.provider}:${entry.id}`} entry={entry} onRemove={() => change(toggleEntry(loadout, entry))} />
            ))}
          </ul>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] overflow-hidden rounded-lg border-t border-l border-border/60">
        {columns.map((group) => (
          <div key={group.provider} className="border-r border-b border-border/60">
            <div className="flex items-center gap-2 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
              <ModelIcon provider={group.provider} />
              <span className="truncate">{columnLabel(group)}</span>
            </div>
            <ul>
              {group.models.map((m) => {
                const on = has(m);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      disabled={!on && full}
                      onClick={() => change(toggleEntry(loadout, m))}
                      className={cn(
                        "flex w-full cursor-pointer items-center justify-between gap-2 border-t border-border/40 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-50",
                        on ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className="truncate">{m.label}</span>
                      {on ? <Check className="size-3.5 shrink-0" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

/** A loadout model the menu doesn't offer now: named, and removable. */
function HiddenEntry({ entry, onRemove }: { entry: LoadoutEntry; onRemove: () => void }) {
  return (
    <li className="relative flex h-24 flex-col justify-between bg-background p-3 opacity-60">
      <ModelIcon provider={entry.provider} />
      <span className="space-y-0.5">
        <span className="block truncate font-mono text-[13px] text-foreground">{entry.id}</span>
        <span className="block text-[11px] text-muted-foreground">Not available: its key isn&apos;t saved</span>
      </span>
      <span className="absolute top-1.5 right-1.5">
        <IconButton label={`Remove ${entry.id}`} onClick={onRemove}>
          <X />
        </IconButton>
      </span>
    </li>
  );
}
