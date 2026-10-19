"use client";

import { useRef, useState } from "react";

import { ClaudeConnection } from "@/components/claude-connection";
import { ConnectionStatus, DetailRow, Details, SectionHeader } from "@/components/settings-details";
import { KeyInput } from "@/components/stored-key";
import { Button } from "@/components/ui/button";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import type { StoredKey } from "@/lib/db/credentials";
import { forgetOutrunnerModels } from "@/lib/desktop/local-runtime";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
import { PROVIDERS, type ProviderId } from "@/lib/providers/registry";
import { PROVIDER_TABS, type ProviderTab } from "@/lib/settings-links";
import { cn } from "@/lib/utils";

/** What Settings → Providers shows (GET /api/settings/providers). */
export type ProviderSettings = { keys: Record<ProviderId, StoredKey> };

/**
 * Settings → Providers (BYOK): the user's Claude subscription and their own
 * keys for model providers, a tab each (lib/providers/registry.ts). Models on
 * them are billed by the provider, not counted against the user's Outrunner
 * plan. The server checks a key with its provider before keeping it.
 */
export function ProviderSettingsForm({
  initial,
  claude: initialClaude,
  tab,
}: {
  initial: ProviderSettings;
  claude: ClaudeTokenMeta;
  /** The tab a link asked for, if any. */
  tab?: ProviderTab;
}) {
  const [keys, setKeys] = useState(initial.keys);
  const [claude, setClaude] = useState(initialClaude);
  const connected = (id: ProviderTab) => (id === "claude" ? claude.connected : keys[id].connected);
  // Without a link's tab, opens on the first one connected, so a returning
  // user lands on it.
  const [active, setActive] = useState<ProviderTab>(
    () => tab ?? PROVIDER_TABS.find(connected) ?? PROVIDER_TABS[0],
  );
  const tabs = useRef<Partial<Record<ProviderTab, HTMLButtonElement | null>>>({});

  function open(next: ProviderTab) {
    setActive(next);
    // A reload, or a link copied from the address bar, comes back here.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  }

  // Arrow keys move between tabs, as in any tablist.
  function onTabKeyDown(event: React.KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const index = PROVIDER_TABS.indexOf(active);
    const next =
      step !== undefined
        ? PROVIDER_TABS[(index + step + PROVIDER_TABS.length) % PROVIDER_TABS.length]
        : event.key === "Home"
          ? PROVIDER_TABS[0]
          : event.key === "End"
            ? PROVIDER_TABS[PROVIDER_TABS.length - 1]
            : null;
    if (!next) return;
    event.preventDefault();
    open(next);
    tabs.current[next]?.focus();
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Providers (BYOK)</h1>
        <p className="text-sm text-muted-foreground">
          Your own Claude subscription and API keys. Models on them are billed by each provider, not counted against
          your Outrunner plan.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Providers"
        onKeyDown={onTabKeyDown}
        className="flex gap-5 overflow-x-auto border-b border-border/60"
      >
        {PROVIDER_TABS.map((id) => {
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
              onClick={() => open(id)}
              className={cn(
                "-mb-px flex shrink-0 cursor-pointer items-center gap-2 border-b-2 pb-2.5 text-sm whitespace-nowrap transition-colors",
                selected
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {id === "claude" ? "Claude subscription" : PROVIDERS[id].label}
              {connected(id) ? (
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
      {PROVIDER_TABS.map((id) => (
        <div
          key={id}
          role="tabpanel"
          id={`provider-panel-${id}`}
          aria-labelledby={`provider-tab-${id}`}
          hidden={id !== active}
        >
          {id === "claude" ? (
            <ClaudeConnection meta={claude} onChange={setClaude} />
          ) : (
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
          )}
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
        <SectionHeader title="API key" link={{ href: keysUrl, label: keysPage }} />
        <ConnectionStatus connected={stored.connected} />
        <Details>
          <DetailRow term="Key">
            {stored.connected ? (
              <span className="font-mono">····{stored.hint ?? "····"}</span>
            ) : (
              <span className="text-muted-foreground">None saved</span>
            )}
          </DetailRow>
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
