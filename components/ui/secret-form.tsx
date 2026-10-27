"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";

/** One secret (an API key, a pasted token) and Save. Cleared once saved; a
 *  failed save says why under it and keeps what was typed. */
export function SecretForm({ placeholder, onSave }: { placeholder: string; onSave: (value: string) => Promise<unknown> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim() || busy) return;
        setBusy(true);
        setError(null);
        onSave(value.trim())
          .then(() => setValue(""))
          .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't save that."))
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex gap-2">
        <div className="relative flex-1">
          <KeyRound className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="pl-8 font-mono text-xs"
          />
        </div>
        <LoadingButton type="submit" variant="outline" status={busy ? "pending" : "idle"} disabled={!value.trim()} labels={{ idle: "Save", pending: "Saving" }} />
      </div>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </form>
  );
}
