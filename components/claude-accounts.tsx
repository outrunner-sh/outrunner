"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RunnerTabs, RUNNERS, TerminalCommand, useCliAccount, useOrigin } from "@/components/claude-from-terminal";
import { SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { useNow } from "@/hooks/use-now";
import { checkLabel } from "@/lib/claude/account-label";
import type { ClaudeAccountView } from "@/lib/claude/accounts";
import { requestJson } from "@/lib/http/request-json";
import { connectClaudeCommand } from "@/lib/onboarding/rules";

type Answer = { accounts: ClaudeAccountView[]; max: number };

const ENDPOINT = "/api/settings/claude/accounts";
/** How often an open Add form looks for an account connected from the terminal. */
const POLL_MS = 3_000;
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
  // Said once an account lands, until the next change.
  const [notice, setNotice] = useState<string | null>(null);
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
      setNotice(null);
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
  // Where sessions start: the first that isn't limited, rejected or unreadable.
  const starts = accounts.findIndex((account) => canStart(account, now));

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

  /** An account connected, by the terminal or a pasted token: the list as it now is. */
  const landed = (next: Answer, label: string) => {
    setAnswer(next);
    setAdding(false);
    setError(null);
    setNotice(`Connected ${label}.`);
    onChange();
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
              <AccountState account={account} starts={index === starts} now={now} />
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

      {adding && answer ? (
        <AddAccount before={answer.accounts} onLanded={landed} onCancel={() => setAdding(false)} />
      ) : answer !== null && accounts.length < max ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            setNotice(null);
            setAdding(true);
          }}
        >
          Add another account
        </Button>
      ) : answer !== null ? (
        <p className="text-xs text-muted-foreground">You&apos;ve connected {max} Claude accounts, the most you can.</p>
      ) : null}

      {notice ? <p className="text-xs text-muted-foreground" role="status">{notice}</p> : null}
      {error ? <InlineMessage>{error}</InlineMessage> : null}
    </div>
  );
}

/**
 * Connect another Claude account: from the terminal, where the CLI signs in
 * to Claude and saves the token under the name (watched for here), or by
 * pasting a token from `claude setup-token`. Either way the person signs in
 * to Claude with the other account, which a browser already signed in to the
 * first makes easy to get wrong, so it says how not to.
 */
function AddAccount({
  before,
  onLanded,
  onCancel,
}: {
  /** The accounts as the form opened: one not among them, or with a new token, is the one. */
  before: ClaudeAccountView[];
  onLanded: (next: Answer, label: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [manager, setManager] = useState(0);
  const [pasting, setPasting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = useCliAccount();
  const origin = useOrigin();

  const typed = label.trim() ? checkLabel(label) : null;
  const name = typed && "label" in typed ? typed.label : "personal";
  const command = account === undefined ? null : connectClaudeCommand(RUNNERS[manager][1], origin, account ?? undefined, name);

  // Watch for the terminal to save it: an account not there as the form
  // opened, or one whose token changed (its name was used again).
  const [baseline] = useState(() => new Map(before.map((a) => [a.id, a.last4])));
  const latest = useRef(onLanded);
  useEffect(() => {
    latest.current = onLanded;
  });
  useEffect(() => {
    let live = true;
    const look = async () => {
      if (document.hidden) return;
      const now = await requestJson<Answer>(ENDPOINT, { has: isAnswer }).catch(() => null);
      const fresh = now?.accounts.find((a) => !baseline.has(a.id) || baseline.get(a.id) !== a.last4);
      if (live && now && fresh) latest.current(now, fresh.label);
    };
    const timer = setInterval(() => void look(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [baseline]);

  const save = async () => {
    const checked = checkLabel(label.trim() ? label : "personal");
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await requestJson<Answer>(ENDPOINT, {
        method: "POST",
        body: { label: checked.label, token },
        has: isAnswer,
        fallback: "Couldn't save that Claude account.",
      });
      onLanded(next, checked.label);
    } catch (e) {
      setError(message(e, "Couldn't save that Claude account."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 rounded-md border border-border/60 p-3">
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
        {typed && "error" in typed ? <span className="block text-warning">{typed.error}</span> : null}
      </label>

      {!pasting ? (
        <div className="space-y-2">
          <p className="text-sm text-foreground">Run this in a terminal on your computer</p>
          <RunnerTabs manager={manager} onChange={setManager} />
          <TerminalCommand command={command} />
          <p className="text-xs text-muted-foreground">
            It opens Claude in your browser. Sign in with the other Claude account, not the one already connected.
            This list updates by itself once it&apos;s saved.
          </p>
          <button
            type="button"
            onClick={() => setPasting(true)}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Or paste a token instead
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <ol className="list-decimal space-y-2 pl-4 text-xs text-muted-foreground">
            <li className="space-y-1.5">
              <span>In a terminal on your computer, run:</span>
              <TerminalCommand command="claude setup-token" />
            </li>
            <li>When your browser opens, sign in with the other Claude account.</li>
            <li>
              Paste the token it prints, starting <code className="font-mono">sk-ant-oat01-</code>:
            </li>
          </ol>
          <input
            id="claude-account-token"
            type="password"
            aria-label="Claude token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && token.trim() && !saving) void save();
            }}
            placeholder="sk-ant-oat01-…"
            autoComplete="off"
            spellCheck={false}
            className="border-border bg-transparent h-9 w-full rounded-md border px-3 font-mono text-sm text-foreground"
          />
          <div className="flex items-center gap-3">
            <LoadingButton status={saving ? "pending" : "idle"} labels={{ idle: "Save account" }} disabled={!token.trim()} onClick={() => void save()} />
            <button
              type="button"
              onClick={() => setPasting(false)}
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Use the terminal command instead
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Already signed in to claude.ai as the first account? Sign out there first, or open the sign-in link in a private
        window.
      </p>
      {error ? <InlineMessage>{error}</InlineMessage> : null}
      <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function canStart(account: ClaudeAccountView, now: number): boolean {
  if (account.needsReconnect || account.unreadable) return false;
  return !account.limitedUntil || !(Date.parse(account.limitedUntil) > now);
}

/** Whether a session can start on it, in words. */
function AccountState({ account, starts, now }: { account: ClaudeAccountView; starts: boolean; now: number }) {
  if (account.unreadable || account.needsReconnect) {
    return (
      <span className="text-xs text-warning">
        This token can&apos;t be used, so sessions skip it. Add it again under the same name to replace it.
      </span>
    );
  }
  const until = account.limitedUntil ? Date.parse(account.limitedUntil) : NaN;
  if (until > now) return <span className="text-xs text-warning">At its usage limit until {when(until, now)}</span>;
  return <span className="text-xs text-muted-foreground">{starts ? "Sessions start here" : "Ready"}</span>;
}

function when(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}
