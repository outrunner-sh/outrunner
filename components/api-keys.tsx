"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineMessage } from "@/components/ui/notice";
import type { ApiKeyRecord } from "@/lib/db/api-keys";
import { requestJson } from "@/lib/http/request-json";

/** How long a new key lasts, as the form offers it. */
const EXPIRIES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: null, label: "Never" },
] as const;

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A key's state in a word: working, revoked, or expired. */
function keyState(key: ApiKeyRecord): string {
  if (key.revokedAt) return `Revoked ${when(key.revokedAt)}`;
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) return `Expired ${when(key.expiresAt)}`;
  return key.expiresAt ? `Expires ${when(key.expiresAt)}` : "Doesn't expire";
}

/**
 * A list of API keys with a form to make one and a button to revoke each:
 * the org's (Settings → Org → API keys) or the user's own (Settings → API
 * keys). A new key is shown once, here, and never again: Outrunner keeps
 * only its hash.
 */
export function ApiKeysSettings({
  endpoint,
  initial,
  showMaker,
}: {
  /** The route that lists, makes and revokes them. */
  endpoint: string;
  initial: ApiKeyRecord[];
  /** Whether to say who made each (an org's keys are its admins'). */
  showMaker: boolean;
}) {
  const [keys, setKeys] = useState(initial);
  const [name, setName] = useState("");
  const [days, setDays] = useState<number | null>(90);
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const answer = await requestJson<{ key: string; keys: ApiKeyRecord[] }>(endpoint, {
        method: "POST",
        body: { name, expiresInDays: days },
        has: (d) => typeof d.key === "string" && Array.isArray(d.keys),
        fallback: "Couldn't make that key. Try again.",
      });
      setKeys(answer.keys);
      setMade(answer.key);
      setCopied(false);
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make that key.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const answer = await requestJson<{ keys: ApiKeyRecord[] }>(`${endpoint}?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        has: (d) => Array.isArray(d.keys),
        fallback: "Couldn't revoke that key. Try again.",
      });
      setKeys(answer.keys);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't revoke that key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="space-y-3 border-t border-border/60 pt-6">
        <h2 className="text-sm font-medium text-foreground">New key</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 space-y-1 text-xs text-muted-foreground">
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CI, a script, an agent" maxLength={80} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Expires
            <select
              className="block h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              value={days ?? "never"}
              onChange={(e) => setDays(e.target.value === "never" ? null : Number(e.target.value))}
            >
              {EXPIRIES.map((option) => (
                <option key={option.label} value={option.days ?? "never"}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy || !name.trim()}>
            Make key
          </Button>
        </div>
      </form>

      {made && (
        <div className="space-y-2 rounded-md border border-border bg-accent/40 p-4">
          <p className="text-sm text-foreground">Copy the key now. Outrunner won&apos;t show it again.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 font-mono text-xs">{made}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void navigator.clipboard?.writeText(made).then(() => setCopied(true))}
            >
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      {error && <InlineMessage>{error}</InlineMessage>}

      <div className="space-y-3 border-t border-border/60 pt-6">
        <h2 className="text-sm font-medium text-foreground">Keys</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No keys yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {keys.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0 space-y-0.5">
                  <p className={key.revokedAt ? "text-sm text-muted-foreground line-through" : "text-sm text-foreground"}>
                    {key.name} <span className="font-mono text-xs text-muted-foreground">or_key_····{key.hint}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      showMaker ? `Made by ${key.createdBy} ${when(key.createdAt)}` : `Made ${when(key.createdAt)}`,
                      keyState(key),
                      key.lastUsedAt ? `Last used ${when(key.lastUsedAt)}` : "Never used",
                      `${key.recentCalls} ${key.recentCalls === 1 ? "call" : "calls"} in 30 days`,
                    ].join(" · ")}
                  </p>
                </div>
                {!key.revokedAt && (
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revoke(key.id)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
