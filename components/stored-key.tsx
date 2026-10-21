"use client";

import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { StoredKey } from "@/lib/db/credentials";

/** A field for a key or a token's part, hidden unless `reveal` (a token id,
 *  which isn't secret). */
export function KeyInput({
  value,
  onChange,
  onKeyDown,
  placeholder,
  label,
  reveal,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  placeholder: string;
  label: string;
  reveal?: boolean;
}) {
  return (
    <input
      type={reveal ? "text" : "password"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label={label}
      // "off" doesn't stop browsers or password managers filling a password
      // field with a saved login; a key is never one.
      autoComplete={reveal ? "off" : "new-password"}
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      spellCheck={false}
      className="border-border bg-background/60 h-9 min-w-48 flex-1 rounded-md border px-3 text-sm"
    />
  );
}

/** A stored key: its last 4 characters, and the way to replace or remove it. */
export function SavedKey({
  what,
  stored,
  busy,
  onReplace,
  onRemove,
}: {
  what: "Key" | "Token";
  stored: StoredKey;
  busy: boolean;
  onReplace: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <Check className="size-4 text-positive" />
        <p className="text-sm text-foreground">
          {what} saved
          {stored.hint ? <span className="text-muted-foreground"> · ends ····{stored.hint}</span> : null}
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onReplace}>
          Replace
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
          Remove {what.toLowerCase()}
        </Button>
      </div>
    </div>
  );
}
