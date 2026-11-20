"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/notice";
import { personalTokenNotes, type PersonalTokenView } from "@/lib/github/personal-token";
import { requestJson } from "@/lib/http/request-json";

const NEW_FINE_GRAINED = "https://github.com/settings/personal-access-tokens/new";
const NEW_CLASSIC = "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Outrunner";
const TOKENS = "https://github.com/settings/tokens";
const FINE_GRAINED_TOKENS = "https://github.com/settings/personal-access-tokens";

/**
 * Settings → Connections → GitHub → personal access token: for repositories
 * the Outrunner GitHub App isn't installed on, such as an organization whose
 * owner hasn't approved it. The user's sessions clone, push and open pull
 * requests with it, over the App connection (lib/github/personal.ts); an
 * org's repositories still come from its App (lib/github/repository-source.ts).
 * `health` is streamed in by the server: whether GitHub still takes it.
 */
export function GitHubTokenCard({ initial, health }: { initial: PersonalTokenView | null; health?: React.ReactNode }) {
  const router = useRouter();
  const [token, setToken] = useState(initial);
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When the page opened: expiry notes are by the day, so it needn't tick.
  const [now] = useState(() => Date.now());
  const [done, setDone] = useState<{ tone: "info" | "warning"; text: string; revoke?: string } | null>(null);

  async function save() {
    if (busy) return;
    setBusy("save");
    setError(null);
    setDone(null);
    try {
      const data = await requestJson<{ token: PersonalTokenView; identitySwitched: boolean }>("/api/github/token", {
        method: "POST",
        body: { token: value },
        has: (d) => d.token !== undefined,
        fallback: "Couldn't save the token. Try again.",
      });
      setToken(data.token);
      setValue("");
      setEditing(false);
      setDone(
        data.identitySwitched
          ? {
              tone: "info",
              text: `Saved. Sessions you start now clone, push and open pull requests as @${data.token.login}; ones already running switch as their git asks again.`,
            }
          : {
              tone: "warning",
              text: `Saved, but your sessions still work as Outrunner's GitHub App. Choose "My GitHub account" below to use @${data.token.login}'s token.`,
            },
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the token. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy("remove");
    setError(null);
    setDone(null);
    try {
      await requestJson<{ token: null }>("/api/github/token", {
        method: "DELETE",
        has: (d) => d.token === null,
        fallback: "Couldn't remove the token. Try again.",
      });
      // Where its kind is revoked, before it's cleared.
      const revoke = token?.kind === "fine_grained" ? FINE_GRAINED_TOKENS : TOKENS;
      setToken(null);
      setDone({
        tone: "warning",
        text: "Removed. Sessions already running keep it until they end, so revoke it on GitHub too if you no longer want it used.",
        revoke,
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove the token. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const notes = token ? personalTokenNotes(token, now) : [];
  const showForm = token === null || editing;

  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">Personal access token</span>
        {token && (
          <span className="text-xs text-muted-foreground">
            Using <span className="font-mono">@{token.login}</span>&apos;s {token.kind === "classic" ? "classic" : "fine-grained"} token
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        For repositories Outrunner&apos;s GitHub App can&apos;t reach, such as an organization whose owner hasn&apos;t
        approved it. Your sessions clone, push and open pull requests with it instead of the connection above, and they
        show as the token&apos;s account. An org&apos;s repositories still come from its GitHub App.
      </p>

      {notes.map((note) => (
        <InlineMessage key={note.text} tone={note.tone}>
          {note.text}
        </InlineMessage>
      ))}
      {token && health}

      {showForm && (
        <form
          className="max-w-md space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="text-xs text-muted-foreground">
            Create a{" "}
            <a href={NEW_FINE_GRAINED} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              fine-grained token
            </a>{" "}
            with an expiry date, with Contents, Pull requests and Workflows read and write; or a{" "}
            <a href={NEW_CLASSIC} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              classic token
            </a>{" "}
            with <code>repo</code>. If the organization uses SAML single sign-on, authorize the token for it on GitHub.
          </p>
          <label className="block space-y-1 text-sm">
            <span className="sr-only">GitHub personal access token</span>
            <input
              type="password"
              autoComplete="off"
              placeholder="github_pat_… or ghp_…"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy !== null}
              required
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy !== null || !value.trim()}>
              {busy === "save" ? "Checking…" : token ? "Replace token" : "Use token"}
            </Button>
            {editing && (
              <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}

      {token && !editing && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setEditing(true)}>
            Replace token
          </Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void remove()}>
            {busy === "remove" ? "Removing…" : "Remove token"}
          </Button>
        </div>
      )}

      {done && (
        <InlineMessage
          tone={done.tone}
          actions={done.revoke ? [{ label: "Revoke on GitHub", href: done.revoke, external: true }] : undefined}
        >
          {done.text}
        </InlineMessage>
      )}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </div>
  );
}
