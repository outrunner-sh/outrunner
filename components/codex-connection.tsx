"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/notice";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";

export type CodexMeta = {
  connected: boolean;
  reconnect: boolean;
  updatedAt: string | null;
  pending: { id: string; expiresAt: string; mine?: boolean } | null;
};
type Scopes = { user: string; orgs: Org[]; activeOrg: string | null };
// Set only after a release containing codex-auth is published. Never assume
// the registry's mutable latest tag contains this deployment's commands.
const configuredVersion = process.env.NEXT_PUBLIC_CODEX_CLI_VERSION ?? "";
const cliVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(configuredVersion)
  ? configuredVersion
  : null;
const configuredLauncher = process.env.NEXT_PUBLIC_CODEX_AUTH_LAUNCHER_PATH ?? "";
const launcherPath = /^\/[A-Za-z0-9/_-]+$/.test(configuredLauncher)
  ? configuredLauncher
  : null;

/** Native login stays on the user's computer; this page receives status only. */
export function CodexConnection({ active = true }: { active?: boolean }) {
  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [scope, setScope] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    void requestJson<Scopes>("/api/settings/codex?scopes=1")
      .then((value) => {
        if (!gone) {
          setScopes(value);
          setScope(value.activeOrg ?? "");
        }
      })
      .catch(() => {
        if (!gone)
          setError("Couldn't load your Codex connection. Reload to try again.");
      });
    return () => {
      gone = true;
    };
  }, []);
  if (!scopes)
    return (
      <div>
        {error ? (
          <InlineMessage>{error}</InlineMessage>
        ) : (
          <p className="text-sm text-muted-foreground">
            Loading Codex connection…
          </p>
        )}
      </div>
    );
  const org = scopes.orgs.find((o) => o.id === scope);
  return (
    <div className="space-y-4">
      <label className="block space-y-2 text-sm">
        <span className="font-medium">Connection belongs to</span>
        <select
          aria-label="Connection belongs to"
          className="block w-full rounded-md border bg-background px-3 py-2"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="">Personal · Only you</option>
          {scopes.orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} · Organization
            </option>
          ))}
        </select>
      </label>
      <ConnectionScope
        key={scope}
        org={org}
        user={scopes.user}
        active={active}
      />
    </div>
  );
}

function ConnectionScope({
  org,
  user,
  active,
}: {
  org?: Org;
  user: string;
  active: boolean;
}) {
  const endpoint = `/api/settings/codex${org ? `?org=${org.id}` : ""}`;
  const [meta, setMeta] = useState<CodexMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState<string | null>(null);
  const admin = !org || org.role === "admin";
  useEffect(() => {
    let gone = false;
    let lastPending: CodexMeta["pending"] = null;
    const load = () => {
      if (document.hidden) return;
      void requestJson<CodexMeta>(endpoint)
        .then((value) => {
          if (!gone) {
            if (
              lastPending &&
              !value.pending &&
              Date.parse(lastPending.expiresAt) <= Date.now()
            )
              setExpired(true);
            lastPending = value.pending;
            setMeta(value);
            setError(null);
            setOrigin(window.location.origin);
          }
        })
        .catch((e: unknown) => {
          if (!gone)
            setError(
              e instanceof Error ? e.message : "Couldn't read this connection.",
            );
        });
    };
    load();
    const timer = active ? setInterval(load, 3000) : null;
    return () => {
      gone = true;
      if (timer) clearInterval(timer);
    };
  }, [endpoint, active]);
  async function change(action: "begin" | "cancel" | "disconnect") {
    setBusy(true);
    setCopied(false);
    try {
      const value = await requestJson<CodexMeta>(endpoint, {
        method: action === "disconnect" ? "DELETE" : "POST",
        body:
          action === "disconnect"
            ? undefined
            : { action, attempt: meta?.pending?.id },
      });
      setMeta(value);
      setError(null);
      setExpired(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't update this connection.",
      );
    } finally {
      setBusy(false);
    }
  }
  const command =
    meta?.pending && origin && cliVersion && !launcherPath
      ? `npx outrunner@${cliVersion} --url ${origin} --account ${user} codex-auth${org ? ` --org ${org.id}` : ""} --attempt ${meta.pending.id}`
      : null;
  return (
    <section
      aria-label={
        org ? `${org.name} Codex connection` : "Personal Codex connection"
      }
      className="rounded-lg border border-border/70 p-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-medium">
          {org
            ? `${org.name} · Shared Codex account`
            : "Personal Codex account"}
        </h3>
        <span role="status" className="text-sm text-muted-foreground">
          {meta?.pending
            ? "Waiting for sign-in"
            : meta?.reconnect
              ? "Reconnect needed"
              : meta?.connected
                ? "Connected"
                : meta
                  ? "Not connected"
                  : "Loading…"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {org
          ? "An admin connects once. Current organization members can use this account in their cloud sessions, including new computers. Their personal credentials and saved authentication choices take priority. Usage counts toward this ChatGPT plan's limits."
          : "Connect your ChatGPT account through the official Codex CLI. This personal connection takes priority over organization defaults and is available only to you."}
      </p>
      <p className="text-xs text-muted-foreground">
        {org
          ? "Only organization admins can connect, replace, cancel or disconnect. Removing a member or disconnecting prevents future requests; an already running request may finish."
          : "Disconnecting prevents future requests from existing computers too."}{" "}
        You won’t need to sign in again for each computer.
      </p>
      {expired && (
        <InlineMessage>
          This sign-in attempt expired. Start a new connection to get another
          approval code.
        </InlineMessage>
      )}
      {meta?.reconnect && (
        <InlineMessage>
          Codex rejected renewal.{" "}
          {admin
            ? "Reconnect to continue using this account."
            : "Ask an organization admin to reconnect."}
        </InlineMessage>
      )}
      {admin && launcherPath && (
        <div className="space-y-2">
          <p className="text-sm">
            This isolated test runs the branch CLI for you. Open the private
            approval launcher, select Approve on OpenAI, and enter its displayed
            code in your browser. No local terminal command is needed. If no
            code is active, start device login in the launcher.
          </p>
          <a className="text-sm underline" href={launcherPath}>
            Open private approval launcher
          </a>
        </div>
      )}
      {admin && !launcherPath && !cliVersion && (
        <InlineMessage>
          Codex sign-in needs an Outrunner CLI release containing codex-auth.
          This deployment has not configured a supported release yet. Existing
          connections and API-key authentication remain available.
        </InlineMessage>
      )}
      {meta?.pending && admin && meta.pending.mine !== false && !launcherPath && cliVersion && (
        <div className="space-y-3">
          <p className="text-sm">
            Run this command on your computer, then approve the official OpenAI
            device login in your browser. Install Codex first with{" "}
            <code>npm install -g @openai/codex</code> if needed.
          </p>
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
            <Terminal className="size-4 shrink-0 mt-0.5" />
            <code className="flex-1 break-all text-xs">
              {command ?? "Preparing command…"}
            </code>
            <button
              type="button"
              aria-label="Copy Codex connection command"
              disabled={!command}
              onClick={() => {
                if (command)
                  void navigator.clipboard
                    .writeText(command)
                    .then(() => setCopied(true))
                    .catch(() =>
                      setError(
                        "Couldn't copy. Select the command and copy it manually.",
                      ),
                    );
              }}
            >
              {copied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            This attempt expires at{" "}
            {new Date(meta.pending.expiresAt).toLocaleTimeString()}. Approval
            codes belong in the official OpenAI page. No credentials need to be
            pasted here. Your existing connection stays active until its
            replacement succeeds.
          </p>
        </div>
      )}
      {meta?.pending?.mine === false && admin && (
        <p className="text-sm text-muted-foreground">
          Another admin started this sign-in. You can cancel it to start your
          own.
        </p>
      )}
      {admin && meta && (
        <div className="flex flex-wrap gap-2">
          {meta.pending ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void change("cancel")}
            >
              Cancel sign-in
            </Button>
          ) : !launcherPath ? (
            <Button
              variant="outline"
              disabled={busy || !cliVersion}
              onClick={() => void change("begin")}
            >
              {meta.connected
                ? "Replace connection"
                : meta.reconnect
                  ? "Reconnect Codex"
                  : "Connect Codex"}
            </Button>
          ) : null}
          {(meta.connected || meta.reconnect) && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void change("disconnect")}
            >
              Disconnect
            </Button>
          )}
        </div>
      )}
      {!admin && (
        <p className="text-sm text-muted-foreground">
          An organization admin manages this connection. When connected, it is
          available to your cloud sessions.
        </p>
      )}
      {error && <InlineMessage>{error}</InlineMessage>}
    </section>
  );
}
