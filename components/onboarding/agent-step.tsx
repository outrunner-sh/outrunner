"use client";

import { Check, KeyRound, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { ClaudeIcon, OpenAIIcon } from "@/components/brand-icons";
import { ClaudeConnection } from "@/components/claude-connection";
import { CommandSnippet } from "@/components/onboarding/checklist-row";
import { OptionCards } from "@/components/option-cards";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { agentReady, initialPick } from "@/lib/onboarding/rules";
import type { AgentMethod, AgentPick, AgentStatus, OnboardingEnv } from "@/lib/onboarding/types";

/** How often the page looks for a subscription connected from the terminal. */
const TERMINAL_POLL_MS = 3_000;

/** The command that connects Claude from the user's terminal (the outrunner
 *  CLI: it signs the terminal in, then runs `claude setup-token`). */
export const CONNECT_COMMAND = "npx outrunner@latest";

/**
 * Step 1: the coding agent, and how it signs in. Claude Code on the user's
 * subscription (connected from their terminal, or with a pasted token; in the
 * Mac app, one click) or an Anthropic API key; Codex on an OpenAI key; or
 * Outrunner's own models, where the server runs them.
 */
export function AgentStep({
  env,
  status,
  onStatus,
  onDone,
}: {
  env: OnboardingEnv;
  status: AgentStatus | null;
  onStatus: (status: AgentStatus) => void;
  onDone: () => void;
}) {
  const [pick, setPick] = useState<AgentPick>(() => initialPick(status, env.outrunnerModels));
  const [method, setMethod] = useState<AgentMethod>(
    status && !status.claude.subscription && status.claude.apiKey ? "api-key" : "subscription",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = agentReady(pick, method, status);

  // A subscription connected from the terminal lands on the server: look for
  // it while it's what the page is waiting on, and the page is in view.
  const waitingOnTerminal = pick === "claude" && method === "subscription" && !ready && !env.desktop;
  useEffect(() => {
    if (!waitingOnTerminal) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      env.agentStatus().then(onStatus, () => {});
    }, TERMINAL_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingOnTerminal, env, onStatus]);

  const options = [
    { id: "claude" as const, label: "Claude Code", icon: ClaudeIcon, connected: Boolean(status?.claude.subscription || status?.claude.apiKey) },
    { id: "codex" as const, label: "Codex", icon: OpenAIIcon, connected: Boolean(status?.codex.apiKey) },
    ...(env.outrunnerModels ? [{ id: "outrunner" as const, label: "Outrunner's models", icon: Sparkles }] : []),
  ];

  async function next() {
    setBusy(true);
    setError(null);
    try {
      // Sessions run on what was connected here, from now on.
      if (pick !== "outrunner") await env.chooseMethod(pick, pick === "codex" ? "api-key" : method);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Choose a coding agent</h1>
        <p className="text-muted-foreground text-sm">It runs in your sessions, on your own account or on Outrunner&apos;s models.</p>
      </div>

      <OptionCards options={options} chosen={ready ? pick : null} shown={pick} onSelect={setPick} label="Coding agent" chosenLabel="ready" />

      <div className="border-border/60 bg-card/30 space-y-4 rounded-xl border p-4">
        {pick === "claude" && (
          <>
            <MethodTabs method={method} onMethod={setMethod} />
            {method === "subscription" ? (
              status?.claude.subscription ? (
                <Connected detail={status.claude.last4 ? `Subscription · …${status.claude.last4}` : "Subscription"} />
              ) : env.desktop ? (
                <ClaudeConnection
                  meta={{ connected: false, last4: null }}
                  onChange={() => void env.agentStatus().then(onStatus, () => {})}
                />
              ) : (
                <SubscriptionFromTerminal env={env} onStatus={onStatus} />
              )
            ) : status?.claude.apiKey ? (
              <Connected detail="Anthropic API key" />
            ) : (
              <ApiKeyForm placeholder="sk-ant-api…" onSave={(key) => env.saveApiKey("anthropic", key).then(onStatus)} />
            )}
          </>
        )}
        {pick === "codex" &&
          (status?.codex.apiKey ? (
            <Connected detail="OpenAI API key" />
          ) : (
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm">Codex runs in the cloud on an OpenAI API key.</p>
              <ApiKeyForm placeholder="sk-…" onSave={(key) => env.saveApiKey("openai", key).then(onStatus)} />
            </div>
          ))}
        {pick === "outrunner" && (
          <p className="text-muted-foreground text-sm">
            Sessions run on Outrunner&apos;s models, nothing to connect. You can add your own Claude Code or Codex later in
            Settings → Providers.
          </p>
        )}
      </div>

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

      <div className="flex justify-end">
        <LoadingButton
          size="default"
          status={busy ? "pending" : "idle"}
          disabled={!ready}
          onClick={() => void next()}
          labels={{ idle: "Continue", pending: "Saving" }}
        />
      </div>
    </section>
  );
}

function MethodTabs({ method, onMethod }: { method: AgentMethod; onMethod: (method: AgentMethod) => void }) {
  return (
    <div role="tablist" aria-label="How Claude Code signs in" className="bg-muted/40 inline-flex rounded-lg p-0.5 text-xs">
      {(
        [
          ["subscription", "Subscription"],
          ["api-key", "API key"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={method === id}
          onClick={() => onMethod(id)}
          className={
            method === id
              ? "bg-background text-foreground rounded-md px-3 py-1 shadow-sm"
              : "text-muted-foreground hover:text-foreground rounded-md px-3 py-1"
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Connected({ detail }: { detail: string }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      <span className="bg-success/15 text-success flex size-5 items-center justify-center rounded-full">
        <Check className="size-3" strokeWidth={3} />
      </span>
      Connected <span className="text-muted-foreground">· {detail}</span>
    </p>
  );
}

/** Connect the subscription from the user's terminal (the page moves on when
 *  it lands), or paste a token from `claude setup-token`. */
function SubscriptionFromTerminal({ env, onStatus }: { env: OnboardingEnv; onStatus: (status: AgentStatus) => void }) {
  const [pasting, setPasting] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-sm">Run this in your terminal. It signs it in, then connects your Claude subscription:</p>
      <CommandSnippet command={CONNECT_COMMAND} />
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <span className="bg-muted-foreground/60 size-1.5 animate-pulse rounded-full" />
        Waiting for it to connect. This page moves on by itself.
      </p>
      {pasting ? (
        <ApiKeyForm
          placeholder="Paste the token from claude setup-token"
          onSave={(token) => env.saveClaudeToken(token).then(onStatus)}
        />
      ) : (
        <button type="button" onClick={() => setPasting(true)} className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline">
          Or paste a token from <code className="font-mono">claude setup-token</code>
        </button>
      )}
    </div>
  );
}

function ApiKeyForm({ placeholder, onSave }: { placeholder: string; onSave: (value: string) => Promise<unknown> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim() || busy) return;
        setBusy(true);
        setError(null);
        onSave(value.trim())
          .then(() => setValue(""))
          .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't save that."))
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex gap-2">
        <div className="relative flex-1">
          <KeyRound className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="pl-8 font-mono text-xs"
          />
        </div>
        <LoadingButton type="submit" variant="outline" status={busy ? "pending" : "idle"} disabled={!value.trim()} labels={{ idle: "Save", pending: "Saving" }} />
      </div>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </form>
  );
}
