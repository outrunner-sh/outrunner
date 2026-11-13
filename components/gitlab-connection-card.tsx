"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export type GitLabConnectionView = { login: string; updatedAt: string } | null;

export function GitLabConnectionCard({ initial }: { initial: GitLabConnectionView }) {
  const [connection, setConnection] = useState(initial);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(!initial);
  const [error, setError] = useState<string | null>(null);

  async function save(disconnect = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/gitlab/connection", {
        method: disconnect ? "DELETE" : "POST", headers: { "Content-Type": "application/json" },
        ...(disconnect ? {} : { body: JSON.stringify({ token }) }),
      });
      const data = await response.json() as { error?: string; connection: GitLabConnectionView };
      if (!response.ok) throw new Error(data.error ?? "Could not connect GitLab. Try again.");
      setConnection(data.connection);
      setToken("");
      setEditing(disconnect);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not connect GitLab. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">GitLab</h2>
        {connection && <span className="text-xs text-muted-foreground">Connected as @{connection.login}</span>}
      </div>
      <p className="text-sm text-muted-foreground">Connect GitLab.com to browse your repositories and run cloud sessions, including repositories in subgroups.</p>
      {editing && (
        <form className="max-w-md space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <p className="text-xs text-muted-foreground">
            Create a <a href="https://gitlab.com/-/user_settings/personal_access_tokens" target="_blank" rel="noreferrer" className="underline underline-offset-4">personal access token</a> with <code>api</code> scope to browse repositories, push code and open merge requests. Your token stays private to you.
          </p>
          <label className="block space-y-1 text-sm">
            <span>GitLab personal access token</span>
            <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} required className="w-full rounded-md border border-input bg-background px-3 py-2" />
          </label>
          <Button type="submit" size="sm" disabled={busy || !token.trim()}>{busy ? "Connecting…" : connection ? "Replace token" : "Connect GitLab"}</Button>
        </form>
      )}
      {connection && <div className="flex gap-2">
        {!editing && <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>Replace token</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>Disconnect GitLab</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
