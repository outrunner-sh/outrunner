"use client";

import { Check, Copy, Terminal } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { SecretForm } from "@/components/ui/secret-form";
import { watchClaudeToken } from "@/lib/claude-connect";
import { CLI_DEFAULT_URL, connectClaudeCommand } from "@/lib/onboarding/rules";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/** How often the page looks for a subscription connected from the terminal. */
const POLL_MS = 3_000;

/** How each package manager runs the CLI that connects Claude from the
 *  user's terminal (it signs the terminal in, then runs `claude setup-token`). */
const RUNNERS = [
  ["npm", "npx"],
  ["pnpm", "pnpm dlx"],
  ["yarn", "yarn dlx"],
  ["bun", "bunx"],
] as const;

/** This app's origin, which never changes while the page is open; the
 *  CLI's default on the server, which can't know it. */
const noSubscription = () => () => {};
function useOrigin(): string {
  return useSyncExternalStore(noSubscription, () => window.location.origin, () => CLI_DEFAULT_URL);
}

/**
 * Connect the Claude subscription from the user's terminal, on the web: the
 * CLI command by package manager, as Replicas shows it, and a token from
 * `claude setup-token` pasted instead. Onboarding and Settings → Providers
 * both show it.
 *
 * The CLI saves the token to the account itself, so this watches for it
 * while `active` (watchClaudeToken). A token saved since `before` (what was in
 * place as this opened) is the one; `onLanded` hears of it once, though the
 * watch and a pasted token can both see it, and never after this is gone.
 * `onSaving` says while a pasted token is being saved.
 */
export function ClaudeFromTerminal({
  before,
  orgId,
  check,
  saveToken,
  onLanded,
  active = true,
  next,
  onSaving,
}: {
  orgId?: string;
  before: ClaudeTokenMeta;
  /** The subscription as the server has it now. */
  check: () => Promise<ClaudeTokenMeta>;
  /** Save a pasted token; the subscription as it then is. */
  saveToken: (token: string) => Promise<ClaudeTokenMeta>;
  onLanded: (meta: ClaudeTokenMeta) => void;
  /** Whether this is on screen: hidden, it doesn't watch. */
  active?: boolean;
  /** What happens once it's connected, said under the command. */
  next: string;
  onSaving?: (saving: boolean) => void;
}) {
  const [manager, setManager] = useState(0);
  const [pasting, setPasting] = useState(false);
  const [copied, setCopied] = useState(false);
  // The account this page is signed in to, so a terminal signed in to
  // another one signs in again rather than save the token there. Undefined
  // while it's read: the command isn't shown or copied until it's known, or
  // null when it can't be, and then goes without --account.
  const [account, setAccount] = useState<string | null>();
  useEffect(() => {
    if (orgId) return;
    void createSupabaseBrowserClient()
      .auth.getSession()
      .then(
        ({ data }) => {
          if (!data.session) console.warn("Connect Claude: no session, so the command doesn't name the account");
          setAccount(data.session?.user.id ?? null);
        },
        (error: unknown) => {
          console.warn("Connect Claude: couldn't read the session, so the command doesn't name the account", error);
          setAccount(null);
        },
      );
  }, [orgId]);
  const origin = useOrigin();
  const command = orgId ? "claude setup-token" : account === undefined ? null : connectClaudeCommand(RUNNERS[manager][1], origin, account ?? undefined);

  // What was in place as this opened, kept: the page's own copy moves on.
  const [baseline] = useState(before);
  // Once, by the watch or a pasted token, and not after this is gone: a
  // pasted token's save can answer after a Cancel or a Disconnect.
  const went = useRef(false);
  const gone = useRef(false);
  const land = (meta: ClaudeTokenMeta) => {
    if (went.current || gone.current) return;
    went.current = true;
    onLanded(meta);
  };
  // The watch reads the latest callbacks through this, not a stale render's.
  const latest = useRef({ check, land });
  useEffect(() => {
    latest.current = { check, land };
  });
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    return watchClaudeToken({
      before: baseline,
      check: () => latest.current.check(),
      onLanded: (meta) => latest.current.land(meta),
      everyMs: POLL_MS,
      hidden: () => document.hidden,
      onVisible: (look) => {
        document.addEventListener("visibilitychange", look);
        return () => document.removeEventListener("visibilitychange", look);
      },
    });
  }, [active, baseline]);

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">{orgId ? "Run this command, then paste the token below to connect the organization’s Claude account" : "Run the CLI and connect your Claude Code account"}</p>
      {!orgId && <div role="tablist" aria-label="Package manager" className="flex gap-4 text-xs">
        {RUNNERS.map(([name], index) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={index === manager}
            onClick={() => setManager(index)}
            className={cn("pb-1", index === manager ? "border-foreground text-foreground border-b" : "text-muted-foreground hover:text-foreground")}
          >
            {name}
          </button>
        ))}
      </div>}
      <div className="bg-muted/40 border-border/60 flex items-center gap-2 rounded-md border px-3 py-2.5">
        <Terminal className="text-amber-500 size-3.5 shrink-0" />
        <code className={cn("flex-1 font-mono text-xs", !command && "text-muted-foreground")}>{command ?? "…"}</code>
        <button
          type="button"
          aria-label="Copy"
          disabled={!command}
          onClick={() => {
            if (!command) return;
            void navigator.clipboard?.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <p className="text-muted-foreground text-xs">{orgId ? "Approve in your browser, then paste the token printed in your terminal here." : "Claude will give you a code to paste into your terminal."} {next}</p>
      {pasting || orgId ? (
        <SecretForm
          placeholder="Paste the token from claude setup-token"
          // Saved here, so it's the one: no need to tell it from the one before.
          onSave={(token) => {
            onSaving?.(true);
            return saveToken(token)
              .then((meta) => {
                if (meta.connected) land(meta);
              })
              .finally(() => onSaving?.(false));
          }}
        />
      ) : (
        <button type="button" onClick={() => setPasting(true)} className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline">
          Or paste a token from <code className="font-mono">claude setup-token</code>
        </button>
      )}
    </div>
  );
}
