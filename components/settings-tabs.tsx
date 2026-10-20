"use client";

import { useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * A row of tabs, with arrow keys, Home and End moving between them as in any
 * tablist. The panels are the caller's: each is `{idPrefix}-panel-{id}`,
 * labelled by its tab.
 */
export function SettingsTabs<Id extends string>({
  ids,
  active,
  onOpen,
  label,
  idPrefix,
  tabLabel,
  connected,
}: {
  ids: Id[];
  active: Id;
  onOpen: (id: Id) => void;
  label: string;
  idPrefix: string;
  tabLabel: (id: Id) => React.ReactNode;
  /** Whether a tab shows the dot that says it's connected. */
  connected: (id: Id) => boolean;
}) {
  const tabs = useRef<Partial<Record<Id, HTMLButtonElement | null>>>({});

  function onKeyDown(event: React.KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const index = ids.indexOf(active);
    const next =
      step !== undefined
        ? ids[(index + step + ids.length) % ids.length]
        : event.key === "Home"
          ? ids[0]
          : event.key === "End"
            ? ids[ids.length - 1]
            : null;
    if (!next) return;
    event.preventDefault();
    onOpen(next);
    tabs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex gap-5 overflow-x-auto border-b border-border/60"
    >
      {ids.map((id) => {
        const selected = id === active;
        return (
          <button
            key={id}
            ref={(el) => {
              tabs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onOpen(id)}
            className={cn(
              "-mb-px flex shrink-0 cursor-pointer items-center gap-2 border-b-2 pb-2.5 text-sm whitespace-nowrap transition-colors",
              selected
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tabLabel(id)}
            {connected(id) ? (
              <>
                <span aria-hidden className="size-1.5 rounded-full bg-positive" />
                <span className="sr-only">(connected)</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
