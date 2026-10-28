"use client";

import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineMessage } from "@/components/ui/notice";
import type { WebhookSettingsView } from "@/lib/api/webhook-routes";
import { requestJson } from "@/lib/http/request-json";

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Webhooks, beside the API keys they're for: the endpoint that hears every
 * event (a session's own `webhook_url` hears its events too), the secret
 * deliveries are signed with, and how the latest ones went.
 */
export function ApiWebhooksSettings({ endpoint, initial }: { endpoint: string; initial: WebhookSettingsView }) {
  const [view, setView] = useState(initial);
  const [url, setUrl] = useState(initial.url ?? "");
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function put(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const next = await requestJson<WebhookSettingsView>(endpoint, {
        method: "PUT",
        body,
        has: (d) => typeof d.secret === "string",
      });
      setView(next);
      setUrl(next.url ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 border-t border-border/60 pt-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-foreground">Webhooks</h2>
        <p className="max-w-prose text-xs text-muted-foreground">
          Sessions these keys start send workspace.ready, turn.completed, needs_input, pr.opened and error to this endpoint,
          and to any <code className="font-mono">webhook_url</code> a session is started with. Each is signed with the
          secret below (the <code className="font-mono">Outrunner-Signature</code> header) and tried again with backoff until
          it&apos;s answered 2xx.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void put({ url: url.trim() || null });
        }}
      >
        <label className="min-w-64 flex-1 space-y-1 text-xs text-muted-foreground">
          Endpoint
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/outrunner" />
        </label>
        <Button type="submit" variant="outline" disabled={busy || url.trim() === (view.url ?? "")}>
          Save
        </Button>
      </form>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Signing secret</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-accent/40 px-2 py-1.5 font-mono text-xs">
            {shown ? view.secret : "whsec_••••••••••••••••"}
          </code>
          <Button type="button" variant="ghost" size="sm" onClick={() => setShown(!shown)} aria-label={shown ? "Hide" : "Show"}>
            {shown ? <EyeOff /> : <Eye />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void navigator.clipboard?.writeText(view.secret).then(() => setCopied(true))}
            aria-label="Copy"
          >
            {copied ? <Check /> : <Copy />}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void put({ rotate: true })}>
            Rotate
          </Button>
        </div>
      </div>
      {error && <InlineMessage>{error}</InlineMessage>}
      {view.deliveries.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Latest deliveries</p>
          <ul className="divide-y divide-border/60 text-xs">
            {view.deliveries.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 py-2">
                <span className="min-w-0 truncate">
                  <span className="font-mono text-foreground">{d.event}</span>{" "}
                  <span className="text-muted-foreground">{new URL(d.url).host}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {d.deliveredAt
                    ? `Delivered ${when(d.deliveredAt)}`
                    : d.nextAttemptAt
                      ? `${d.lastError ?? "Waiting"} · try ${d.attempts + 1} ${when(d.nextAttemptAt)}`
                      : `Gave up after ${d.attempts} tries${d.lastError ? `: ${d.lastError}` : ""}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
