"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import { ConnectionStatus, DetailRow, Details, SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage, Notice, TickingFact } from "@/components/ui/notice";
import { useNow } from "@/hooks/use-now";
import {
  cancelClaudeLogin,
  pollClaudeLogin,
  startClaudeLogin,
  submitClaudeCode,
} from "@/lib/desktop/connect-claude";
import { isDesktopApp } from "@/lib/is-desktop";
import { requestJson } from "@/lib/http/request-json";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";

const noopSubscribe = () => () => {};

/** How long `claude setup-token` is given to hear back from the browser. */
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

/**
 * Claude Code's Subscription card in Settings → Providers: connect the
 * user's Claude subscription. The card above says what it is.
 *
 * Desktop-only: one click runs `claude setup-token` natively (logging in via the
 * browser if needed), then stores the minted token server-side. Sandboxes the
 * user creates then run on their own subscription instead of the platform key.
 * The page reads `meta`; every change here goes back through `onChange`.
 */
export function ClaudeConnection({
  meta,
  onChange,
}: {
  meta: ClaudeTokenMeta;
  onChange: (meta: ClaudeTokenMeta) => void;
}) {
  const [busy, setBusy] = useState(false);
  // Watching for the CLI to finish after the browser opened. Kept apart from
  // `busy` so Cancel and the code fallback stay usable for the whole wait.
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether we're inside the Tauri shell — an unchanging client-only fact, so
  // read it as an external store (false during SSR) rather than via effect.
  const desktop = useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);

  // The CLI blocks on a browser round-trip, so connecting is two phases: open
  // the authorize URL, then hand back the code it produces. `pending` holds the
  // URL while we wait for the user to return with it.
  const [pending, setPending] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // When the CLI stops waiting, for the countdown; and whether the user asked
  // for the code field, which only matters if Claude falls back to one.
  const [deadline, setDeadline] = useState<number | null>(null);
  const [pasting, setPasting] = useState(false);
  const [expired, setExpired] = useState(false);

  /** Store a freshly minted token and clear the in-progress state. */
  const save = useCallback(async (token: string) => {
    onChange(
      await requestJson<ClaudeTokenMeta>("/api/settings/claude", {
        method: "PUT",
        body: { token },
        has: (d) => typeof d.connected === "boolean",
        fallback: "Could not save the token.",
      }),
    );
    setPending(null);
    setCode("");
    // A save means the login finished, whatever the approval window was doing.
    setExpired(false);
  }, [onChange]);

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
      try {
        await save(token);
      } catch (e) {
        // The login finished but its token isn't stored, so this attempt is
        // over and says why. Moving it on stops its poll, which would otherwise
        // run the window out as if no approval had come.
        attempt.current++;
        setPending(null);
        setWaiting(false);
        setError(e instanceof Error ? e.message : "Could not save the token.");
        return;
      }
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
    setExpired(false);
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
    const deadline = Date.now() + LOGIN_WINDOW_MS;
    setDeadline(deadline);
    setPasting(false);
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
      setExpired(true);
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
    setPasting(false);
    setCode("");
  }, []);

  const abandon = useCallback(() => {
    stopLogin();
    setError(null);
  }, [stopLogin]);

  const disconnect = useCallback(async () => {
    // A Reconnect still waiting must not save a token after this.
    stopLogin();
    // The window's line is this login's story, not whatever comes next: a
    // failed Disconnect has to be the one on screen, not talked over.
    setExpired(false);
    setBusy(true);
    try {
      onChange(
        await requestJson<ClaudeTokenMeta>("/api/settings/claude", {
          method: "DELETE",
          has: (d) => typeof d.connected === "boolean",
          fallback: "Could not disconnect.",
        }),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnecting failed.");
    } finally {
      setBusy(false);
    }
  }, [stopLogin, onChange]);

  const { connected } = meta;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionHeader title="Subscription" />
        <ConnectionStatus connected={connected} />
        <Details>
          <DetailRow term="Token">
            {connected ? (
              <span className="font-mono">····{meta.last4 ?? "····"}</span>
            ) : (
              <span className="text-muted-foreground">None saved</span>
            )}
          </DetailRow>
          <DetailRow term="Billing">Your Claude plan</DetailRow>
          <DetailRow term="Applies to">Workspaces created or restored after connecting</DetailRow>
        </Details>
      </div>

      {desktop && pending && deadline ? (
        <div className="space-y-3">
          <Notice
            tone="progress"
            className="is-stacked"
            title="Approve in your browser"
            detail={<ApprovalWindow url={pending} until={deadline} />}
            actions={[
              { label: "Open again", href: pending, external: true },
              ...(pasting ? [] : [{ label: "Paste a code instead", onClick: () => setPasting(true) }]),
              { label: "Cancel", onClick: abandon, disabled: busy },
            ]}
          />
          {pasting ? (
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && code.trim() && !busy) void finish();
                }}
                placeholder="Paste the code Claude showed you…"
                aria-label="Authorization code"
                autoFocus
                spellCheck={false}
                className="border-border bg-background/60 h-9 flex-1 rounded-md border px-3 text-sm"
              />
              <LoadingButton
                status={busy ? "pending" : "idle"}
                labels={{ idle: "Connect" }}
                disabled={!code.trim()}
                onClick={() => void finish()}
              />
            </div>
          ) : null}
        </div>
      ) : connected ? (
        <div className="flex gap-2">
          {desktop ? (
            <LoadingButton
              variant="outline"
              status={busy || waiting ? "pending" : "idle"}
              labels={{ idle: "Reconnect" }}
              onClick={() => void connect()}
            />
          ) : null}
          <Button variant="ghost" size="sm" disabled={busy} onClick={disconnect}>
            Disconnect
          </Button>
        </div>
      ) : desktop ? (
        <div className="space-y-2">
          <LoadingButton
            status={busy ? "pending" : "idle"}
            labels={{ idle: "Connect Claude" }}
            onClick={() => void connect()}
          />
          <p className="text-xs text-muted-foreground">
            Runs <code className="font-mono">claude setup-token</code> on this machine, so Claude Code must be
            installed. Approve in the browser and it finishes by itself.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Open Outrunner in the desktop app to connect your Claude subscription.
        </p>
      )}

      {expired ? (
        <InlineMessage tone="warning">
          The approval window closed after five minutes.{" "}
          {connected ? "Your connection is unchanged." : "Nothing was connected."}
        </InlineMessage>
      ) : error ? (
        <InlineMessage>{error}</InlineMessage>
      ) : null}
    </div>
  );
}

/** How long the CLI keeps waiting for the browser, counted down to the second. */
function ApprovalWindow({ url, until }: { url: string; until: number }) {
  const now = useNow(1000);
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  const left = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <>
      A tab opened on {hostOf(url)}. This window stays open for five minutes.{" "}
      {/* The countdown ticks every second: hidden from screen readers, so the
          live region says the sentence once, not once per second. */}
      <TickingFact className="text-foreground tabular-nums">{left} left</TickingFact>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "Claude";
  }
}
