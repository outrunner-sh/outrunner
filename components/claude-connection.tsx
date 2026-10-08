"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  cancelClaudeLogin,
  pollClaudeLogin,
  startClaudeLogin,
  submitClaudeCode,
} from "@/lib/desktop/connect-claude";
import { isDesktopApp } from "@/lib/is-desktop";

type Meta = { connected: boolean; last4: string | null };

/** Current connection status, or null when the request failed. */
async function fetchClaudeMeta(): Promise<Meta | null> {
  try {
    const res = await fetch("/api/settings/claude");
    return res.ok ? ((await res.json()) as Meta) : null;
  } catch {
    return null;
  }
}

const noopSubscribe = () => () => {};

/**
 * Settings card for connecting the user's Claude subscription.
 *
 * Desktop-only: one click runs `claude setup-token` natively (logging in via the
 * browser if needed), then stores the minted token server-side. Sandboxes the
 * user creates then run on their own subscription instead of the platform key.
 */
export function ClaudeConnection() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [busy, setBusy] = useState(false);
  // Watching for the CLI to finish after the browser opened. Kept apart from
  // `busy` so Cancel and the code fallback stay usable for the whole wait.
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether we're inside the Tauri shell — an unchanging client-only fact, so
  // read it as an external store (false during SSR) rather than via effect.
  const desktop = useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);

  useEffect(() => {
    let active = true;
    void fetchClaudeMeta().then((m) => {
      if (active && m) setMeta(m);
    });
    return () => {
      active = false;
    };
  }, []);

  // The CLI blocks on a browser round-trip, so connecting is two phases: open
  // the authorize URL, then hand back the code it produces. `pending` holds the
  // URL while we wait for the user to return with it.
  const [pending, setPending] = useState<string | null>(null);
  const [code, setCode] = useState("");

  /** Store a freshly minted token and clear the in-progress state. */
  const save = useCallback(async (token: string) => {
    const res = await fetch("/api/settings/claude", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? "Could not save the token.");
    }
    setMeta((await res.json()) as Meta);
    setPending(null);
    setCode("");
  }, []);

  // The login attempt the page is following. Cancel, Disconnect and a new
  // Connect move it on, so an older loop stops polling, saving or touching the
  // page: it can neither time out a newer login nor reconnect after Disconnect.
  const attempt = useRef(0);
  // The attempt whose token was taken, by the poll or by a pasted code. The two
  // can race for it; the loser's "no login in progress" is not an error.
  const claimed = useRef(0);

  /** The one way a login finishes: save its token, once, if still wanted. */
  const complete = useCallback(
    async (mine: number, token: string) => {
      if (attempt.current !== mine || claimed.current === mine) return;
      claimed.current = mine;
      await save(token);
      // A pasted code may have lost the race and shown an error meanwhile.
      setError(null);
    },
    [save],
  );

  const connect = useCallback(async () => {
    const mine = ++attempt.current;
    const current = () => attempt.current === mine;
    setBusy(true);
    setError(null);
    let url: string;
    try {
      url = await startClaudeLogin();
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : "Connecting Claude failed.");
      return;
    } finally {
      setBusy(false);
    }
    if (!current()) return;
    setPending(url);
    // The shell bounces off-site navigations to the system browser, which is
    // where this has to happen: Claude blocks embedded webviews, and the URL
    // bar is the user's anti-phishing signal.
    window.open(url, "_blank");

    // Authorizing usually completes the login outright, so watch for the
    // token rather than asking for a code that will never be issued. The code
    // field stays on screen meanwhile, for the CLI's fallback prompt.
    setWaiting(true);
    try {
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        // Don't swallow a rejection here. A silent catch once hid a missing ACL
        // grant: every poll was rejected, the loop gave up on the first tick,
        // and the UI sat on the code field while the token was already in hand.
        const poll = await pollClaudeLogin();
        if (!current() || poll.state === "ended") return;
        if (poll.state === "done") {
          await complete(mine, poll.token);
          return;
        }
      }
      void cancelClaudeLogin();
      setPending(null);
      setError("No answer from the browser after five minutes. Start again.");
    } catch (e) {
      if (!current()) return;
      setPending(null);
      setError(e instanceof Error ? e.message : "Connecting Claude failed.");
    } finally {
      // A newer attempt owns `waiting` now.
      if (current()) setWaiting(false);
    }
  }, [complete]);

  const finish = useCallback(async () => {
    const mine = attempt.current;
    setBusy(true);
    setError(null);
    try {
      await complete(mine, await submitClaudeCode(code));
    } catch (e) {
      // The poll may have taken this token first and saved it.
      if (attempt.current === mine && claimed.current !== mine) {
        setError(e instanceof Error ? e.message : "Connecting Claude failed.");
      }
    } finally {
      setBusy(false);
    }
  }, [code, complete]);

  /** Stop following the login in progress, if any, and stop its CLI. */
  const stopLogin = useCallback(() => {
    attempt.current++;
    void cancelClaudeLogin();
    setPending(null);
    setWaiting(false);
    setCode("");
  }, []);

  const abandon = useCallback(() => {
    stopLogin();
    setError(null);
  }, [stopLogin]);

  const disconnect = useCallback(async () => {
    // A Reconnect still waiting must not save a token after this.
    stopLogin();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/claude", { method: "DELETE" });
      if (!res.ok) throw new Error("Could not disconnect.");
      setMeta((await res.json()) as Meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnecting failed.");
    } finally {
      setBusy(false);
    }
  }, [stopLogin]);

  const connected = meta?.connected ?? false;

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Claude</h1>
        <p className="text-sm text-muted-foreground">
          Connect your Claude subscription so your workspaces run on your own
          account instead of the shared one.
        </p>
      </div>

      <div className="rounded-lg border border-border/60 p-4">
        {connected ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Check className="size-4 text-emerald-500" />
                <p className="text-sm text-foreground">
                  Connected
                  {meta?.last4 ? (
                    <span className="text-muted-foreground"> · ends ····{meta.last4}</span>
                  ) : null}
                </p>
              </div>
              <div className="flex gap-2">
                {desktop ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || waiting}
                    onClick={connect}
                    aria-label="Reconnect"
                  >
                    {busy || waiting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      "Reconnect"
                    )}
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" disabled={busy} onClick={disconnect}>
                  Disconnect
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Applies to workspaces created or restored after connecting.
            </p>
          </div>
        ) : desktop && pending ? (
          <div className="space-y-3">
            <p className="text-sm text-foreground">
              {waiting
                ? "Waiting for you to authorize in the browser…"
                : "Authorize in your browser to finish."}
            </p>
            <p className="text-xs text-muted-foreground">
              This finishes on its own once you approve. Only paste a code below
              if Claude asks you for one.
            </p>
            <p className="text-xs text-muted-foreground">
              Didn&apos;t open?{" "}
              <a
                href={pending}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                Open the sign-in page
              </a>
            </p>
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && code.trim() && !busy) void finish();
                }}
                placeholder="Paste the code…"
                aria-label="Authorization code"
                autoFocus
                spellCheck={false}
                className="border-border bg-background/60 h-9 flex-1 rounded-md border px-3 text-sm"
              />
              <Button size="sm" disabled={busy || !code.trim()} onClick={finish}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : "Connect"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={abandon}>
                Cancel
              </Button>
            </div>
          </div>
        ) : desktop ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">Not connected.</p>
            <Button size="sm" disabled={busy} onClick={connect}>
              {busy ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" /> Connecting…
                </span>
              ) : (
                "Connect Claude"
              )}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Open Runtime in the desktop app to connect your Claude subscription.
          </p>
        )}

        {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
      </div>
    </section>
  );
}
