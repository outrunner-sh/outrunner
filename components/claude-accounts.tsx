"use client";

import { useCallback, useEffect, useState } from "react";

import { SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { useNow } from "@/hooks/use-now";
import type { ClaudeAccountView } from "@/lib/claude/accounts";
import { requestJson } from "@/lib/http/request-json";

type Answer = { accounts: ClaudeAccountView[]; max: number };

const ENDPOINT = "/api/settings/claude/accounts";
const isAnswer = (data: Partial<Answer>) => Array.isArray(data.accounts) && typeof data.max === "number";
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * The person's Claude subscriptions, under the Subscription card in Settings
 * → Providers (lib/claude/accounts.ts): sessions start on the first that
 * isn't at its usage limit. Add another under a name, put them in order, or
 * remove one. `onChange` follows every change, since the card above shows the
 * first account's token.
 */
export function ClaudeAccounts({ onChange }: { onChange: () => void }) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What's being saved: an account's id (removing it), "order" or "add".
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const now = useNow(60_000);

  useEffect(() => {
    let live = true;
    requestJson<Answer>(ENDPOINT, { has: isAnswer, fallback: "Couldn't load your Claude accounts." })
      .then((loaded) => live && setAnswer(loaded))
      .catch((e: unknown) => live && setError(message(e, "Couldn't load your Claude accounts.")));
    return () => {
      live = false;
    };
  }, []);

  /** Send one change; the answer is the accounts as they now are. */
  const run = useCallback(
    async (what: string, send: () => Promise<Answer>): Promise<boolean> => {
      setBusy(what);
      setError(null);
      try {
        setAnswer(await send());
        onChange();
        return true;
      } catch (e) {
        setError(message(e, "That didn't save. Try again."));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [onChange],
  );

  const accounts = answer?.accounts ?? [];
  const max = answer?.max ?? 10;

  const move = (index: number, by: -1 | 1) => {
    const ids = accounts.map((account) => account.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    void run("order", () =>
      requestJson<Answer>(ENDPOINT, { method: "PATCH", body: { order: ids }, has: isAnswer, fallback: "Couldn't reorder your Claude accounts." }),
    );
  };

  const remove = (account: ClaudeAccountView) =>
    void run(account.id, () =>
      requestJson<Answer>(`${ENDPOINT}/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        has: isAnswer,
        fallback: `Couldn't remove ${account.label}. It's still connected.`,
      }),
    );

  const add = async () => {
    const saved = await run("add", () =>
      requestJson<Answer>(ENDPOINT, { method: "POST", body: { label, token }, has: isAnswer, fallback: "Couldn't save that Claude account." }),
    );
    if (saved) {
      setLabel("");
      setToken("");
      setAdding(false);
    }
  };

  return (
    <div className="space-y-3">
      <SectionHeader title="Accounts" />
      <p className="text-xs text-muted-foreground">
        Sessions start on the first account that isn&apos;t at its usage limit. Add another of your own Claude
        subscriptions to keep working when one runs out.
      </p>

      {answer === null && !error ? <p className="text-xs text-muted-foreground">Loading your Claude accounts…</p> : null}

      {accounts.length > 0 ? (
        <ol className="divide-y divide-border/60 rounded-md border border-border/60" aria-label="Claude accounts, in the order sessions use them">
          {accounts.map((account, index) => (
            <li key={account.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="font-medium text-foreground">{account.label}</span>
              <span className="font-mono text-xs text-muted-foreground">····{account.last4 ?? "····"}</span>
              <AccountState account={account} first={index === 0} now={now} />
              <span className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`Move ${account.label} up`}
                  disabled={index === 0 || busy !== null}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`Move ${account.label} down`}
                  disabled={index === accounts.length - 1 || busy !== null}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => remove(account)}>
                  {busy === account.id ? "Removing…" : "Remove"}
                </Button>
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {adding ? (
        <div className="space-y-2 rounded-md border border-border/60 p-3">
          <label className="block space-y-1 text-xs text-muted-foreground" htmlFor="claude-account-label">
            <span>Name</span>
            <input
              id="claude-account-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="personal"
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              className="border-border bg-transparent h-9 w-full rounded-md border px-3 text-sm text-foreground"
            />
          </label>
          <label className="block space-y-1 text-xs text-muted-foreground" htmlFor="claude-account-token">
            <span>Token</span>
            <input
              id="claude-account-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="sk-ant-oat01-…"
              autoComplete="off"
              spellCheck={false}
              className="border-border bg-transparent h-9 w-full rounded-md border px-3 font-mono text-sm text-foreground"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Run <code className="font-mono">claude setup-token</code> signed in to the other Claude account and paste the
            token it prints. Or, in a terminal, run <code className="font-mono">outrunner claude --label personal</code>.
          </p>
          <div className="flex gap-2">
            <LoadingButton
              status={busy === "add" ? "pending" : "idle"}
              labels={{ idle: "Save account" }}
              disabled={!label.trim() || !token.trim() || (busy !== null && busy !== "add")}
              onClick={() => void add()}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={busy === "add"}
              onClick={() => {
                setAdding(false);
                setToken("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : answer !== null && accounts.length < max ? (
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setAdding(true)}>
          Add another account
        </Button>
      ) : answer !== null ? (
        <p className="text-xs text-muted-foreground">You&apos;ve connected {max} Claude accounts, the most you can.</p>
      ) : null}

      {error ? <InlineMessage>{error}</InlineMessage> : null}
    </div>
  );
}

/** Whether a session can start on it, in words. */
function AccountState({ account, first, now }: { account: ClaudeAccountView; first: boolean; now: number }) {
  if (account.needsReconnect) {
    return <span className="text-xs text-warning">Anthropic rejected this token. Save a new one under the same name.</span>;
  }
  const until = account.limitedUntil ? Date.parse(account.limitedUntil) : NaN;
  if (until > now) return <span className="text-xs text-warning">At its usage limit until {when(until, now)}</span>;
  return <span className="text-xs text-muted-foreground">{first ? "Sessions start here" : "Ready"}</span>;
}

function when(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}
