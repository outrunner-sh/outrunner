"use client";

import { KeyRound, Terminal } from "lucide-react";
import type { ComponentType } from "react";

import { ClaudeIcon, OpenAIIcon } from "@/components/brand-icons";
import { OptionCards } from "@/components/option-cards";
import type { AuthMethod, AuthMethodId } from "@/lib/agents/registry";

/** Each way's mark: the plan's brand for a subscription, a terminal for the
 *  Mac's own CLI, a key for an API key. */
const ICONS: Record<AuthMethodId, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  subscription: ClaudeIcon,
  chatgpt: OpenAIIcon,
  local: Terminal,
  "api-key": KeyRound,
};

/**
 * An agent's ways of signing in, a card each (OptionCards): the one `chosen`
 * has a tick, and the one `shown` is the card whose details are below.
 * Choosing a card shows it; a link can show one not chosen.
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
  return (
    <OptionCards
      options={methods.map((method) => ({ id: method.id, label: method.label, icon: ICONS[method.id] }))}
      chosen={chosen}
      shown={shown}
      busy={busy}
      onSelect={onChoose}
      label={label}
    />
  );
}
