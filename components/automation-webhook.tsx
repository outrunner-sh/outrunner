"use client";

import { useState, useSyncExternalStore } from "react";

import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Input } from "@/components/ui/input";
import { InlineMessage } from "@/components/ui/notice";
import type { WebhookUrl } from "@/lib/db/automation-webhooks";
import { requestJson } from "@/lib/http/request-json";

const noSubscription = () => () => {};

/**
 * An automation's webhook: its secret URL to copy, a new one on demand (the
 * old stops working at once), and how to call it. Only its admins see the
 * URL; one not saved yet has none.
 */
export function AutomationWebhook({
  orgId,
  automationId,
  webhook,
  editable,
}: {
  orgId: string;
  /** Null for one not saved yet. */
  automationId: string | null;
  /** Its URL; null when it isn't the viewer's to see, or it's new. */
  webhook: WebhookUrl | null;
  editable: boolean;
}) {
  const origin = useSyncExternalStore(noSubscription, () => window.location.origin, () => "");
  const [current, setCurrent] = useState(webhook?.path ?? null);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = current ? `${origin}${current}` : null;

  const rotate = async () => {
    if (rotating || !automationId) return;
    setRotating(true);
    setError(null);
    try {
      const { path: next } = await requestJson<{ path: string }>(`/api/orgs/${orgId}/automations/${automationId}/webhook`, {
        method: "POST",
        has: (data) => typeof data.path === "string",
        fallback: "Couldn't make a new URL. Try again.",
      });
      setCurrent(next);
      setCopied(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't make a new URL. Try again.");
    } finally {
      setRotating(false);
    }
  };

  if (!editable) {
    return <p className="text-xs text-muted-foreground">Only the org&apos;s admins see its URL.</p>;
  }
  if (!url) {
    if (!automationId) return <p className="text-xs text-muted-foreground">Create it to get its URL.</p>;
    // Saving keeps a token it has, readable or not: only a new one fixes
    // one that can't be read, and it's offered whenever there's none to show.
    const unreadable = webhook !== null && webhook.path === null && webhook.unreadable;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            {unreadable
              ? "Its URL can't be shown (Outrunner's encryption key has changed since it was made). Make a new one: the old one stops working."
              : "Save with Webhook ticked to get its URL, or make one now."}
          </p>
          <HoldToConfirm label="Replace URL" onConfirm={() => void rotate()} disabled={rotating} className="h-7 shrink-0 px-2.5 text-xs" />
        </div>
        {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input readOnly value={url} aria-label="Webhook URL" className="h-7 font-mono text-xs" onFocus={(e) => e.target.select()} />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url).catch(() => {});
            setCopied(true);
          }}
          className="h-7 shrink-0 rounded-md border border-border/60 px-2.5 text-xs text-foreground transition-colors hover:bg-accent"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <HoldToConfirm label="Replace URL" onConfirm={() => void rotate()} disabled={rotating} className="h-7 shrink-0 px-2.5 text-xs" />
      </div>
      <p className="text-xs text-muted-foreground">
        Anyone with this URL can start a run: keep it secret, and replace it if it leaks (the old one stops at
        once). A POST of JSON starts a run on each of the automation&apos;s repositories, or only{" "}
        <span className="font-mono">?repo=owner/name</span>. <span className="font-mono">?wait_for_workspace=true</span>{" "}
        answers once the session is made, with its id and URL. An <span className="font-mono">Idempotency-Key</span>{" "}
        header makes a retry start nothing twice. At most 20 a minute.
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground/80">
        {`curl -X POST '${url}?wait_for_workspace=true' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"text": "Deploy failed on main"}'`}
      </pre>
      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
    </div>
  );
}
