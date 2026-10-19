"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PROVIDERS, type ProviderId } from "@/lib/providers/registry";
import { validModelId } from "@/lib/runtime/session-models";

/**
 * Type in a model a provider serves that the menu doesn't list, to run on the
 * user's own key. Checked for shape here and again on the server; whether the
 * provider has it is for the provider to say when the session runs.
 */
export function CustomModelDialog({
  provider,
  onOpenChange,
  onChoose,
}: {
  /** The provider to choose for; null keeps the dialog closed. */
  provider: ProviderId | null;
  onOpenChange: (open: boolean) => void;
  onChoose: (provider: ProviderId, id: string) => void;
}) {
  const [id, setId] = useState("");
  const trimmed = id.trim();
  const valid = validModelId(trimmed);
  const info = provider ? PROVIDERS[provider] : null;

  const choose = () => {
    if (!provider || !valid) return;
    onChoose(provider, trimmed);
    setId("");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) setId("");
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-sm gap-5 bg-[#0d0d0d]">
        <div className="space-y-2">
          <DialogTitle className="text-[15px] font-medium leading-snug">Another {info?.label} model</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            The model&apos;s id, as {info?.label} names it. It runs on your {info?.label} key.
          </DialogDescription>
        </div>
        <Input
          autoFocus
          value={id}
          onChange={(event) => setId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") choose();
          }}
          placeholder={info?.models[0]?.id}
          aria-label="Model id"
          aria-invalid={trimmed !== "" && !valid}
          spellCheck={false}
          autoComplete="off"
        />
        {trimmed !== "" && !valid ? (
          <p role="alert" className="text-[13px] text-destructive">
            Letters, digits and - . _ : / [ ] ~ only, up to 100, not starting with -.
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className="route-state-button">
            Cancel
          </button>
          <button type="button" onClick={choose} disabled={!valid} className="route-state-button">
            Use model
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
