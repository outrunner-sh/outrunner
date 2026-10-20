"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConnectionStatus, DetailRow, Details, SectionHeader } from "@/components/settings-details";
import { KeyInput } from "@/components/stored-key";
import { Button } from "@/components/ui/button";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import type { StoredKey } from "@/lib/db/credentials";
import { type KeyProviderId, PROVIDERS } from "@/lib/providers/registry";

/** What /api/settings/providers answers a change with: every saved key's
 *  status. */
export type ProviderKeys = Record<KeyProviderId, StoredKey>;

/**
 * A provider's API key: whether one is saved (its last 4, never the key), and
 * the way to save, replace or remove it. The server checks a key with its
 * provider before keeping it. Every change goes back through `onChange`, with
 * every key's status as the server now has it.
 */
export function ApiKeyCard({
  provider,
  stored,
  onChange,
}: {
  provider: KeyProviderId;
  stored: StoredKey;
  onChange: (keys: ProviderKeys) => void;
}) {
  const { label, keyPlaceholder, keysUrl, keysPage, models } = PROVIDERS[provider];
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
        | { keys?: ProviderKeys; error?: string; warning?: string | null }
        | null;
      if (!res.ok || !data?.keys) throw new Error(data?.error ?? "Couldn't save that. Try again.");
      onChange(data.keys);
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
    <div className="space-y-4">
      <div className="space-y-3">
        <SectionHeader title="API key" link={{ href: keysUrl, label: keysPage }} />
        <ConnectionStatus connected={stored.connected} />
        <Details>
          <DetailRow term="Provider">{label}</DetailRow>
          {stored.connected && stored.updatedAt ? (
            <DetailRow term="Saved">
              {/* The browser's own locale and time zone, which the server's
                  render can't know. */}
              <span suppressHydrationWarning>
                {new Date(stored.updatedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
              </span>
            </DetailRow>
          ) : null}
          <DetailRow term="Billing">Your {label} account</DetailRow>
          <DetailRow term="Models">{models.map((model) => model.label).join(", ")}</DetailRow>
        </Details>
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
          <p className="text-xs text-muted-foreground">It&apos;s checked with {label}, then stored encrypted.</p>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-4 py-2.5">
          <span className="font-mono text-sm text-muted-foreground">········{stored.hint ?? "····"}</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Replace ${label} key`}
              title="Replace key"
              onClick={() => setReplacing(true)}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${label} key`}
              title="Remove key"
              disabled={status === "pending"}
              onClick={() => void send("DELETE")}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
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
