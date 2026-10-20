"use client";

import { Check, KeyRound, Terminal } from "lucide-react";
import { type ComponentType, useRef } from "react";

import { ClaudeIcon, OpenAIIcon } from "@/components/brand-icons";
import type { AuthMethod, AuthMethodId } from "@/lib/agents/registry";
import { cn } from "@/lib/utils";

/** Each way's mark: the plan's brand for a subscription, a terminal for the
 *  Mac's own CLI, a key for an API key. */
const ICONS: Record<AuthMethodId, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  subscription: ClaudeIcon,
  chatgpt: OpenAIIcon,
  local: Terminal,
  "api-key": KeyRound,
};

/**
 * An agent's ways of signing in, a card each, as a radio group: the one
 * `chosen` has a tick, and the one `shown` is the card whose details are
 * below. Choosing a card shows it; a link can show one not chosen.
 */
export function AuthMethodCards({
  methods,
  chosen,
  shown,
  busy,
  onChoose,
  label,
}: {
  methods: AuthMethod[];
  chosen: AuthMethodId | null;
  shown: AuthMethodId;
  busy: boolean;
  onChoose: (method: AuthMethodId) => void;
  label: string;
}) {
  const cards = useRef<Partial<Record<AuthMethodId, HTMLButtonElement | null>>>({});

  // Arrow keys move between the cards, as in any radio group.
  function onKeyDown(event: React.KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = methods.findIndex((method) => method.id === shown);
    const next = methods[(index + step + methods.length) % methods.length];
    onChoose(next.id);
    cards.current[next.id]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="grid grid-cols-3 gap-3">
      {methods.map((method) => {
        const Icon = ICONS[method.id];
        const isChosen = method.id === chosen;
        const isShown = method.id === shown;
        return (
          <button
            key={method.id}
            ref={(el) => {
              cards.current[method.id] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isChosen}
            tabIndex={isShown ? 0 : -1}
            disabled={busy}
            onClick={() => onChoose(method.id)}
            className={cn(
              "relative flex h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border text-sm transition-colors disabled:cursor-wait",
              isShown
                ? "border-foreground/40 bg-muted/50 text-foreground"
                : "border-border/60 text-muted-foreground hover:bg-muted/30 hover:text-foreground",
            )}
          >
            {isChosen ? <Check aria-hidden className="absolute top-2.5 right-2.5 size-4 text-foreground" /> : null}
            <Icon aria-hidden className="size-5" />
            <span className={cn(isChosen && "font-medium")}>{method.label}</span>
          </button>
        );
      })}
    </div>
  );
}
