"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import {
  connectDesktopCodex,
  type CodexConnectProgress,
} from "@/lib/desktop/connect-codex";
import type { CodexMeta } from "@/components/codex-connection";

export function DesktopCodexConnection({
  orgId,
  onConnected,
}: {
  orgId?: string;
  onConnected?: (connected: boolean) => void;
}) {
  const [meta, setMeta] = useState<CodexMeta | null>(null);
  const [progress, setProgress] = useState<CodexConnectProgress | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<AbortController | null>(null);
  const endpoint = `/api/settings/codex${orgId ? `?org=${encodeURIComponent(orgId)}` : ""}`;
  useEffect(() => {
    let stale = false;
    void fetch(endpoint, { cache: "no-store" })
      .then(async (r) => {
        const value = await r.json();
        if (!r.ok)
          throw new Error(
            value.error ?? "Couldn't check your Codex connection.",
          );
        if (!stale) setMeta(value);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
      current.current?.abort();
    };
  }, [endpoint]);

  async function connect() {
    const controller = new AbortController();
    current.current?.abort();
    current.current = controller;
    setError(null);
    setProgress({ state: "preparing" });
    try {
      await connectDesktopCodex(orgId, controller.signal, setProgress);
      if (controller.signal.aborted) return;
      setMeta({
        connected: true,
        reconnect: false,
        updatedAt: new Date().toISOString(),
        pending: null,
      });
      onConnected?.(true);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Couldn't connect Codex. Update Outrunner and try again.",
        );
    } finally {
      if (current.current === controller) {
        current.current = null;
        setProgress(null);
      }
    }
  }
  async function disconnect() {
    setChanging(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? "Couldn't disconnect Codex.");
      setMeta(value);
      onConnected?.(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't disconnect.");
    } finally {
      setChanging(false);
    }
  }
  const busy = progress !== null || changing;
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {orgId
          ? "Connect a ChatGPT account for this organization's cloud sessions."
          : "Connect your ChatGPT account for your cloud sessions."}{" "}
        Outrunner handles setup; approve the connection in your browser.
      </p>
      {meta?.connected && (
        <p className="text-sm">
          {meta.reconnect ? "Reconnect needed" : "ChatGPT account connected"}
        </p>
      )}
      {progress?.state === "preparing" && (
        <p role="status" className="text-muted-foreground text-sm">
          Preparing Codex and opening sign-in…
        </p>
      )}
      {progress?.state === "waiting" && (
        <div
          role="status"
          className="bg-muted/30 space-y-3 rounded-md border p-4"
        >
          <p className="text-sm">Approve in your browser using this code:</p>
          <div className="font-mono text-xl tracking-widest">
            {progress.code}
          </div>
          <a
            className="text-sm underline"
            href={progress.url}
            target="_blank"
            rel="noreferrer"
          >
            Open OpenAI sign-in again
          </a>
          <p className="text-muted-foreground text-xs">
            This page continues automatically after approval. Enable device-code
            login in ChatGPT security settings if OpenAI asks.
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <LoadingButton
          status={busy ? "pending" : "idle"}
          labels={{
            idle:
              meta?.connected || meta?.reconnect
                ? "Reconnect ChatGPT account"
                : "Connect ChatGPT account",
            pending: changing ? "Disconnecting" : "Connecting",
          }}
          onClick={() => void connect()}
        />
        {progress ? (
          <Button
            variant="ghost"
            onClick={() => {
              current.current?.abort();
              setProgress(null);
            }}
          >
            Cancel
          </Button>
        ) : (
          meta?.connected && (
            <Button
              variant="ghost"
              disabled={changing}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          )
        )}
      </div>
      {error && <InlineMessage>{error}</InlineMessage>}
    </div>
  );
}
