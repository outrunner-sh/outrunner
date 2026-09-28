"use client";

import { Check, KeyRound, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Mirrors CredentialStatus in lib/db/credentials.ts — presence, never values. */
export type CredentialStatusView = {
  github: { connected: boolean; login: string | null; updatedAt: string | null };
  anthropic: { connected: boolean; hint: string | null; updatedAt: string | null };
};

/**
 * Where a user supplies the credentials their own workspaces run on.
 *
 * Runtime is multi-user: each person's boxes are provisioned with their own
 * Anthropic key, never the operator's. GitHub is read-only here — that token
 * comes from the OAuth sign-in itself, so the only way to (re)connect it is to
 * sign out and back in.
 */
export function CredentialsSettings({ initial }: { initial: CredentialStatusView }) {
  const [status, setStatus] = useState(initial);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(method: "PUT" | "DELETE", body?: unknown) {
    setBusy(method === "PUT" ? "save" : "remove");
    setError(null);
    try {
      const res = await fetch("/api/settings/credentials", {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json()) as CredentialStatusView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setStatus(data);
      setKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h2 className="text-sm font-medium">GitHub</h2>
        {status.github.connected ? (
          <p className="text-sm text-muted-foreground">
            <Check className="mr-1 inline size-4 align-text-bottom" />
            Connected as <span className="font-medium">{status.github.login}</span>. Runtime
            clones, commits and opens pull requests as you.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not connected. Sign out and back in to grant repository access — the GitHub
            token comes from signing in, so there is nothing to paste here.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Claude</h2>
        <p className="text-sm text-muted-foreground">
          Your workspaces run Claude on your own credential, and it is only ever sent to
          your own machines. Use either:
        </p>
        <ul className="text-muted-foreground space-y-2 text-sm">
          <li>
            <span className="text-foreground font-medium">Claude subscription</span> — run{" "}
            <code className="font-mono text-xs">claude setup-token</code> in your terminal
            and paste the <code className="font-mono text-xs">sk-ant-oat…</code> token.
            Uses your Pro/Max plan.
          </li>
          <li>
            <span className="text-foreground font-medium">API key</span> — create one at{" "}
            <a
              className="underline"
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer noopener"
            >
              console.anthropic.com
            </a>
            . Billed as API usage.
          </li>
        </ul>

        {status.anthropic.connected && (
          <p className="text-sm text-muted-foreground">
            <KeyRound className="mr-1 inline size-4 align-text-bottom" />
            Credential ending <code className="font-mono">…{status.anthropic.hint}</code> is
            saved.
          </p>
        )}

        <form
          className="flex max-w-xl gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send("PUT", { anthropicKey: key });
          }}
        >
          <Input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={status.anthropic.connected ? "Replace credential…" : "sk-ant-…"}
            autoComplete="off"
            spellCheck={false}
            aria-label="Anthropic API key or Claude Code token"
          />
          <Button type="submit" disabled={key.trim() === "" || busy !== null}>
            {busy === "save" && <Loader2 className="mr-1 size-4 animate-spin" />}
            Save
          </Button>
          {status.anthropic.connected && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void send("DELETE")}
              aria-label="Remove saved key"
            >
              {busy === "remove" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </Button>
          )}
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>
    </div>
  );
}
