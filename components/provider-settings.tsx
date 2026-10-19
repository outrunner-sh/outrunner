"use client";

import { useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import { KeyInput } from "@/components/stored-key";
import { Button } from "@/components/ui/button";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import type { StoredKey } from "@/lib/db/credentials";
import { forgetOutrunnerModels } from "@/lib/desktop/local-runtime";
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "@/lib/providers/registry";
import { cn } from "@/lib/utils";

/** What Settings → Providers shows (GET /api/settings/providers). */
export type ProviderSettings = { keys: Record<ProviderId, StoredKey> };

/**
 * Settings → Providers: the user's own keys for model providers, a tab each
 * (lib/providers/registry.ts). Models on them are billed by the provider, not
 * counted against the user's Outrunner plan. The server checks a key with its
 * provider before keeping it.
 */
export function ProviderSettingsForm({ initial }: { initial: ProviderSettings }) {
  const [keys, setKeys] = useState(initial.keys);
  // Opens on the first provider with a key, so a returning user lands on it.
  const [active, setActive] = useState<ProviderId>(
    () => PROVIDER_IDS.find((id) => initial.keys[id].connected) ?? PROVIDER_IDS[0],
  );
  const tabs = useRef<Partial<Record<ProviderId, HTMLButtonElement | null>>>({});

  // Arrow keys move between tabs, as in any tablist.
  function onTabKeyDown(event: React.KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const index = PROVIDER_IDS.indexOf(active);
    const next =
      step !== undefined
        ? PROVIDER_IDS[(index + step + PROVIDER_IDS.length) % PROVIDER_IDS.length]
        : event.key === "Home"
          ? PROVIDER_IDS[0]
          : event.key === "End"
            ? PROVIDER_IDS[PROVIDER_IDS.length - 1]
            : null;
    if (!next) return;
    event.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Your own API keys. Models on them are billed by each provider, not counted against your Outrunner plan.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Providers"
        onKeyDown={onTabKeyDown}
        className="flex gap-5 overflow-x-auto border-b border-border/60"
      >
        {PROVIDER_IDS.map((id) => {
          const selected = id === active;
          return (
            <button
              key={id}
              ref={(el) => {
                tabs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={`provider-tab-${id}`}
              aria-selected={selected}
              aria-controls={`provider-panel-${id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(id)}
              className={cn(
                "-mb-px flex shrink-0 cursor-pointer items-center gap-2 border-b-2 pb-2.5 text-sm whitespace-nowrap transition-colors",
                selected
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {PROVIDERS[id].label}
              {keys[id].connected ? (
                <>
                  <span aria-hidden className="size-1.5 rounded-full bg-positive" />
                  <span className="sr-only">(connected)</span>
                </>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Every panel stays mounted, so a key half typed or a save in flight
          survives a look at another tab. */}
      {PROVIDER_IDS.map((id) => (
        <div
          key={id}
          role="tabpanel"
          id={`provider-panel-${id}`}
          aria-labelledby={`provider-tab-${id}`}
          hidden={id !== active}
        >
          <ProviderPanel
            provider={id}
            stored={keys[id]}
            onChange={(next) => {
              // This panel's own provider only: another panel's reply, sent
              // before a change there landed, mustn't undo it here.
              setKeys((current) => ({ ...current, [id]: next.keys[id] }));
              // The model menu offers what keys the user has: let it ask again.
              forgetOutrunnerModels();
            }}
          />
        </div>
      ))}
    </section>
  );
}

function ProviderPanel({
  provider,
  stored,
  onChange,
}: {
  provider: ProviderId;
  stored: StoredKey;
  onChange: (next: ProviderSettings) => void;
}) {
  const { label, description, keyPlaceholder, keysUrl, keysPage, models } = PROVIDERS[provider];
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
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{description}</p>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium text-foreground">API key</h2>
          <a
            href={keysUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {keysPage} <ExternalLink className="size-3" />
          </a>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={cn("size-2 rounded-full", stored.connected ? "bg-positive" : "bg-muted-foreground/50")}
          />
          <span className={stored.connected ? "text-foreground" : "text-muted-foreground"}>
            {stored.connected ? "Connected" : "Not connected"}
          </span>
        </div>

        <dl className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 text-sm">
          <Row term="Key">
            {stored.connected ? (
              <span className="font-mono">····{stored.hint ?? "····"}</span>
            ) : (
              <span className="text-muted-foreground">None saved</span>
            )}
          </Row>
          {stored.connected && stored.updatedAt ? (
            <Row term="Saved">
              {/* The browser's own locale and time zone, which the server's
                  render can't know. */}
              <span suppressHydrationWarning>
                {new Date(stored.updatedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
              </span>
            </Row>
          ) : null}
          <Row term="Billing">Your {label} account</Row>
          <Row term="Models">{models.map((model) => model.label).join(", ")}</Row>
        </dl>
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
            It&apos;s checked with {label}, then stored encrypted.
          </p>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
            Replace key
          </Button>
          <Button variant="ghost" size="sm" disabled={status === "pending"} onClick={() => void send("DELETE")}>
            Remove key
          </Button>
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

/** A row of the details table: a muted term beside its value. */
function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr]">
      <dt className="bg-muted/30 px-4 py-2.5 text-muted-foreground">{term}</dt>
      <dd className="px-4 py-2.5 text-foreground">{children}</dd>
    </div>
  );
}
