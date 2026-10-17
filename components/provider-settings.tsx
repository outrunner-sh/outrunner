"use client";

import { useState } from "react";

import { KeyInput, SavedKey } from "@/components/stored-key";
import { Button } from "@/components/ui/button";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import type { StoredKey } from "@/lib/db/credentials";
import { forgetOutrunnerModels } from "@/lib/desktop/local-runtime";

/** What Settings → Providers shows (GET /api/settings/providers). */
export type ProviderSettings = {
  openrouter: StoredKey;
  /** Whether the server runs Outrunner's models on a key of its own. */
  serverModels: boolean;
};

/**
 * Settings → Providers: the user's own keys for the providers their models
 * run on. OpenRouter's, for now: saved, Outrunner's models run on it and
 * OpenRouter bills the user, with no allowance; without it they run on the
 * server's key, where it has one. The server checks a key with OpenRouter
 * before keeping it.
 */
export function ProviderSettingsForm({ initial }: { initial: ProviderSettings }) {
  const [settings, setSettings] = useState(initial);
  const [key, setKey] = useState("");
  // A saved key is only replaced on purpose.
  const [replacing, setReplacing] = useState(false);
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const own = settings.openrouter.connected;
  const asking = !own || replacing;
  const canSave = asking && key.trim() !== "" && status !== "pending";

  async function send(method: "PUT" | "DELETE", body?: object): Promise<void> {
    setStatus("pending");
    setError(null);
    try {
      const res = await fetch("/api/settings/providers", {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      // A reply that isn't JSON (a proxy's error page) says nothing worth showing.
      const data = (await res.json().catch(() => null)) as (ProviderSettings & { error?: string }) | null;
      if (!res.ok || !data) throw new Error(data?.error ?? "Couldn't save that. Try again.");
      setSettings(data);
      // The model menu names the key it runs on: let it ask again.
      forgetOutrunnerModels();
      setKey("");
      setReplacing(false);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
      setStatus("error");
    }
  }

  const save = () => void send("PUT", { openrouterKey: key.trim() });

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Providers</h1>
        <p className="text-sm text-muted-foreground">Your own keys for the providers your models run on.</p>
      </div>

      <div className="space-y-4 rounded-lg border border-border/60 p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">OpenRouter</p>
          <p className="text-sm text-muted-foreground">
            {own
              ? "Outrunner's models run on your key, and OpenRouter bills you for them."
              : settings.serverModels
                ? "Outrunner's models run on Outrunner's key, up to your plan's included usage. Add your own to run them on your OpenRouter account instead, with no limit but yours."
                : "Add your key to use Outrunner's models: this server has no key of its own for them."}
          </p>
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
                placeholder="Paste your OpenRouter API key (sk-or-…)"
                label="OpenRouter API key"
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
              <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" className="underline underline-offset-4">
                OpenRouter → Keys
              </a>
              . It&apos;s checked with OpenRouter, then stored encrypted. New sessions on Outrunner&apos;s models use it.
            </p>
          </div>
        ) : (
          <SavedKey
            what="Key"
            stored={settings.openrouter}
            busy={status === "pending"}
            onReplace={() => setReplacing(true)}
            onRemove={() => void send("DELETE")}
          />
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
