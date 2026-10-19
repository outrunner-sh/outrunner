"use client";

import { useState } from "react";

import { KeyInput, SavedKey } from "@/components/stored-key";
import { Button } from "@/components/ui/button";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import type { StoredKey } from "@/lib/db/credentials";
import { forgetOutrunnerModels } from "@/lib/desktop/local-runtime";
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "@/lib/providers/registry";

/** What Settings → Providers shows (GET /api/settings/providers). */
export type ProviderSettings = { keys: Record<ProviderId, StoredKey> };

/**
 * Settings → Providers: the user's own keys for model providers, one card
 * each (lib/providers/registry.ts). Models on them are billed by the provider,
 * not counted against the user's Outrunner plan. The server checks a key with
 * its provider before keeping it.
 */
export function ProviderSettingsForm({ initial }: { initial: ProviderSettings }) {
  const [keys, setKeys] = useState(initial.keys);
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Your own API keys. Models on them are billed by each provider, not counted against your Outrunner plan.
        </p>
      </div>
      {PROVIDER_IDS.map((id) => (
        <ProviderKeyCard
          key={id}
          provider={id}
          stored={keys[id]}
          onChange={(next) => {
            setKeys(next.keys);
            // The model menu offers what keys the user has: let it ask again.
            forgetOutrunnerModels();
          }}
        />
      ))}
    </section>
  );
}

function ProviderKeyCard({
  provider,
  stored,
  onChange,
}: {
  provider: ProviderId;
  stored: StoredKey;
  onChange: (next: ProviderSettings) => void;
}) {
  const { label, description, keyPlaceholder, keysUrl, keysPage } = PROVIDERS[provider];
  const [key, setKey] = useState("");
  // A saved key is only replaced on purpose.
  const [replacing, setReplacing] = useState(false);
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const asking = !stored.connected || replacing;
  const canSave = asking && key.trim() !== "" && status !== "pending";

  async function send(method: "PUT" | "DELETE"): Promise<void> {
    setStatus("pending");
    setError(null);
    setWarning(null);
    try {
      const res = await fetch(
        method === "PUT" ? "/api/settings/providers" : `/api/settings/providers?provider=${provider}`,
        {
          method,
          headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
          body: method === "PUT" ? JSON.stringify({ provider, key: key.trim() }) : undefined,
        },
      );
      // A reply that isn't JSON (a proxy's error page) says nothing worth showing.
      const data = (await res.json().catch(() => null)) as
        | (ProviderSettings & { error?: string; warning?: string | null })
        | null;
      if (!res.ok || !data?.keys) throw new Error(data?.error ?? "Couldn't save that. Try again.");
      onChange(data);
      setWarning(data.warning ?? null);
      setKey("");
      setReplacing(false);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
      setStatus("error");
    }
  }

  const save = () => void send("PUT");

  return (
    <div className="space-y-4 rounded-lg border border-border/60 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {asking ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <KeyInput
              value={key}
              onChange={(value) => {
                setKey(value);
                setStatus("idle");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSave) save();
              }}
              placeholder={keyPlaceholder}
              label={`${label} API key`}
            />
            {replacing ? (
              <Button variant="ghost" size="sm" onClick={() => setReplacing(false)}>
                Cancel
              </Button>
            ) : null}
            <LoadingButton
              status={status}
              labels={{ idle: "Save", pending: "Checking", success: "Saved" }}
              disabled={!canSave}
              onClick={save}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Create one in{" "}
            <a href={keysUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              {keysPage}
            </a>
            . It&apos;s checked with {label}, then stored encrypted.
          </p>
        </div>
      ) : (
        <SavedKey
          what="Key"
          stored={stored}
          busy={status === "pending"}
          onReplace={() => setReplacing(true)}
          onRemove={() => void send("DELETE")}
        />
      )}

      {warning ? <p className="text-sm text-warning">{warning}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
