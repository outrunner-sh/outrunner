"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type TypedModelProvider, typedModelOwner } from "@/lib/runtime/custom-models";
import { validModelId } from "@/lib/runtime/session-models";

/**
 * Type in a model a provider serves that the menu doesn't list, to run on the
 * user's own key, or one of OpenAI's for Codex. Checked for shape here and again on the server; whether the
 * provider has it is for the provider to say when the session runs.
 */
export function CustomModelDialog({
  provider,
  onOpenChange,
  onChoose,
}: {
  /** The provider to choose for; null keeps the dialog closed. */
  provider: TypedModelProvider | null;
  onOpenChange: (open: boolean) => void;
  onChoose: (provider: TypedModelProvider, id: string) => void;
}) {
  const [id, setId] = useState("");
  const trimmed = id.trim();
  const valid = validModelId(trimmed);
  const info = provider ? typedModelOwner(provider) : null;

  // Every way out clears what was typed: it was for this provider, and the
  // dialog opens next for whichever one is picked.
  const close = () => {
    setId("");
    onOpenChange(false);
  };

  const choose = () => {
    if (!provider || !valid) return;
    onChoose(provider, trimmed);
    close();
  };

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-sm gap-5 bg-[#0d0d0d]">
        <div className="space-y-2">
          <DialogTitle className="text-[15px] font-medium leading-snug">Another {info?.label} model</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            {provider === "codex"
              ? "The model's id, as OpenAI names it. Codex runs it however you've set it to sign in."
              : `The model's id, as ${info?.namedBy} names it. It runs on your ${info?.label} key.`}
          </DialogDescription>
        </div>
        <Input
          autoFocus
          value={id}
          onChange={(event) => setId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") choose();
          }}
          placeholder={info?.placeholder}
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
          <button type="button" onClick={close} className="route-state-button">
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
