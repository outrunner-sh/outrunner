"use client";

import { Check, Copy, Terminal } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { SecretForm } from "@/components/ui/secret-form";
import { claudeTokenLanded } from "@/lib/claude-connect";
import { CLI_DEFAULT_URL, connectClaudeCommand } from "@/lib/onboarding/rules";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
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
 * The CLI saves the token to the account itself, so this watches for it:
 * while `active`, every few seconds and at once when the user comes back to
 * the tab. A token saved since `before` (what was in place as this opened) is
 * the one; `onLanded` hears of it once, though the watch and a pasted token
 * can both see it.
 */
export function ClaudeFromTerminal({
  before,
  check,
  saveToken,
  onLanded,
  active = true,
  next,
}: {
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
}) {
  const [manager, setManager] = useState(0);
  const [pasting, setPasting] = useState(false);
  const [copied, setCopied] = useState(false);
  const command = connectClaudeCommand(RUNNERS[manager][1], useOrigin());

  // What was in place as this opened, kept: the page's own copy moves on.
  const [baseline] = useState(before);
  const went = useRef(false);
  const land = (meta: ClaudeTokenMeta) => {
    if (went.current) return;
    went.current = true;
    onLanded(meta);
  };
  // The watch reads the latest callbacks through this, not a stale render's.
  const latest = useRef({ check, land });
  useEffect(() => {
    latest.current = { check, land };
  });

  useEffect(() => {
    if (!active) return;
    const look = () => {
      if (document.hidden || went.current) return;
      latest.current.check().then(
        (meta) => {
          if (claudeTokenLanded(meta, baseline)) latest.current.land(meta);
        },
        // A failed look is the next one's to retry.
        () => {},
      );
    };
    look();
    const timer = setInterval(look, POLL_MS);
    document.addEventListener("visibilitychange", look);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", look);
    };
  }, [active, baseline]);

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">Run the CLI and connect your Claude Code account</p>
      <div role="tablist" aria-label="Package manager" className="flex gap-4 text-xs">
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
      </div>
      <div className="bg-muted/40 border-border/60 flex items-center gap-2 rounded-md border px-3 py-2.5">
        <Terminal className="text-amber-500 size-3.5 shrink-0" />
        <code className="flex-1 font-mono text-xs">{command}</code>
        <button
          type="button"
          aria-label="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <p className="text-muted-foreground text-xs">Claude will give you a code to paste into your terminal. {next}</p>
      {pasting ? (
        <SecretForm
          placeholder="Paste the token from claude setup-token"
          // Saved here, so it's the one: no need to tell it from the one before.
          onSave={(token) =>
            saveToken(token).then((meta) => {
              if (meta.connected) land(meta);
            })
          }
        />
      ) : (
        <button type="button" onClick={() => setPasting(true)} className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline">
          Or paste a token from <code className="font-mono">claude setup-token</code>
        </button>
      )}
    </div>
  );
}
