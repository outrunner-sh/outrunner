"use client";

import { Check } from "lucide-react";
import { type ComponentType, useRef } from "react";

import { cn } from "@/lib/utils";

/** One card: its mark, its name, and whether something is saved for it. */
export type OptionCard<Id extends string> = {
  id: Id;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** Shows the dot that says it's connected. */
  connected?: boolean;
};

/**
 * A row of cards as a radio group: the one `chosen` has a tick, and the one
 * `shown` is the card whose details are below. Selecting a card (a click, or
 * arrow keys as in any radio group) calls `onSelect`; whether that also
 * chooses it is the caller's to say.
 */
export function OptionCards<Id extends string>({
  options,
  chosen,
  shown,
  busy = false,
  onSelect,
  label,
}: {
  options: OptionCard<Id>[];
  chosen: Id | null;
  shown: Id;
  busy?: boolean;
  onSelect: (id: Id) => void;
  label: string;
}) {
  const cards = useRef<Partial<Record<Id, HTMLButtonElement | null>>>({});

  function onKeyDown(event: React.KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.id === shown);
    const next = options[(index + step + options.length) % options.length];
    onSelect(next.id);
    cards.current[next.id]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="grid grid-cols-3 gap-3">
      {options.map(({ id, label: name, icon: Icon, connected }) => {
        const isChosen = id === chosen;
        const isShown = id === shown;
        return (
          <button
            key={id}
            ref={(el) => {
              cards.current[id] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isChosen}
            tabIndex={isShown ? 0 : -1}
            disabled={busy}
            onClick={() => onSelect(id)}
            className={cn(
              "relative flex h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border text-sm transition-colors disabled:cursor-wait",
              isShown
                ? "border-foreground/40 bg-muted/50 text-foreground"
                : "border-border/60 text-muted-foreground hover:bg-muted/30 hover:text-foreground",
            )}
          >
            {isChosen ? <Check aria-hidden className="absolute top-2.5 right-2.5 size-4 text-foreground" /> : null}
            {connected && !isChosen ? (
              <>
                <span aria-hidden className="absolute top-3.5 right-3.5 size-1.5 rounded-full bg-positive" />
                <span className="sr-only">(connected)</span>
              </>
            ) : null}
            <Icon aria-hidden className="size-5" />
            <span className={cn(isChosen && "font-medium")}>{name}</span>
          </button>
        );
      })}
    </div>
  );
}
