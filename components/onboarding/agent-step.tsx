"use client";

import { ArrowLeft, Check, ChevronRight, KeyRound, Sparkles } from "lucide-react";
import { type ComponentType, useState } from "react";

import { AgentIcon, ClaudeIcon } from "@/components/brand-icons";
import { ClaudeConnection } from "@/components/claude-connection";
import { ClaudeFromTerminal } from "@/components/claude-from-terminal";
import { LoadingButton } from "@/components/ui/loading-button";
import { SecretForm } from "@/components/ui/secret-form";
import { freeModelsOffer } from "@/lib/onboarding/rules";
import type { AgentPick, AgentStatus, OnboardingEnv } from "@/lib/onboarding/types";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";

type Agent = "claude" | "codex";
type Method = "subscription" | "api-key" | "outrunner";

/** Where in the step the user is: the agents, one agent's ways to connect,
 *  or one way's page. */
type Page = { at: "agents" } | { at: "methods"; agent: Agent } | { at: "connect"; agent: Agent; method: Method };

const AGENT_NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "OpenAI Codex" };

const NO_SUBSCRIPTION: ClaudeTokenMeta = { connected: false, last4: null, updatedAt: null };

/** Whether `method` of `agent` is connected already. */
function connected(agent: Agent, method: Method, status: AgentStatus): boolean {
  if (method === "outrunner") return false;
  if (agent === "codex") return status.codex.apiKey;
  return method === "subscription" ? status.claude.subscription : status.claude.apiKey;
}

/**
 * Step 1, as Replicas' is: choose a coding agent, then how it connects (its
 * subscription, an API key, or Outrunner's models, free to start), then
 * connect. Done once connected, with what sessions run on.
 */
export function AgentStep({
  env,
  status,
  onStatus,
  onDone,
}: {
  env: OnboardingEnv;
  status: AgentStatus;
  onStatus: (status: AgentStatus) => void;
  /** Sessions run on this from now on. */
  onDone: (runOn: AgentPick) => void;
}) {
  const [page, setPage] = useState<Page>({ at: "agents" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish(agent: Agent, method: Method) {
    setBusy(true);
    setError(null);
    try {
      if (method === "outrunner") {
        onDone(agent === "codex" ? "codex-outrunner" : "outrunner");
        return;
      }
      // Sessions sign in this way from now on (Settings → Providers).
      await env.chooseMethod(agent, agent === "codex" ? "api-key" : method);
      onDone(agent);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Onboarding's status, kept current, as the subscription it says. */
  function heard(next: AgentStatus): ClaudeTokenMeta {
    onStatus(next);
    // Only "none yet" to "connected" counts here, which needs no save time.
    return { connected: next.claude.subscription, last4: next.claude.last4, updatedAt: null };
  }

  if (page.at === "agents") {
    return (
      <Page title="Choose a coding agent">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(["claude", "codex"] as const).map((agent) => (
            <button
              key={agent}
              type="button"
              onClick={() => setPage({ at: "methods", agent })}
              className="border-border hover:border-foreground/40 bg-background group flex items-center gap-3 rounded-lg border-2 px-4 py-3 text-left text-sm transition-colors"
            >
              <AgentIcon agent={agent} className="size-5 shrink-0" />
              <span className="flex-1">{AGENT_NAMES[agent]}</span>
              <ChevronRight className="text-muted-foreground group-hover:text-foreground size-4" />
            </button>
          ))}
        </div>
      </Page>
    );
  }

  const { agent } = page;
  const title = (
    <>
      Connect <AgentIcon agent={agent} className="mx-1.5 inline size-5 align-[-3px]" /> <span className="font-normal">{AGENT_NAMES[agent]}</span>
    </>
  );

  if (page.at === "methods") {
    const methods: { id: Method; label: string; icon: ComponentType<{ className?: string }>; note?: string }[] = [
      ...(agent === "claude" ? [{ id: "subscription" as const, label: "Use a subscription", icon: ClaudeIcon }] : []),
      { id: "api-key", label: agent === "claude" ? "Anthropic API key" : "OpenAI API key", icon: KeyRound },
      ...(env.outrunnerModels
        ? [
            {
              id: "outrunner" as const,
              label: "Outrunner's models",
              icon: Sparkles,
              note: freeModelsOffer(),
            },
          ]
        : []),
    ];
    return (
      <Page title={title} onBack={() => setPage({ at: "agents" })}>
        <div className="space-y-2">
          {methods.map((method) => (
            <Row
              key={method.id}
              icon={method.icon}
              label={method.label}
              note={method.note}
              done={connected(agent, method.id, status)}
              onClick={() => setPage({ at: "connect", agent, method: method.id })}
            />
          ))}
        </div>
      </Page>
    );
  }

  const { method } = page;
  const isConnected = connected(agent, method, status);
  return (
    <Page title={title} onBack={() => setPage({ at: "methods", agent })}>
      {method === "subscription" &&
        (isConnected ? (
          <Connected detail={status.claude.last4 ? `Subscription · …${status.claude.last4}` : "Subscription"} />
        ) : env.desktop ? (
          <ClaudeConnection
            meta={NO_SUBSCRIPTION}
            onChange={(meta) => {
              void env.agentStatus().then(onStatus, () => {});
              if (meta.connected) void finish("claude", "subscription");
            }}
          />
        ) : (
          <ClaudeFromTerminal
            before={NO_SUBSCRIPTION}
            check={() => env.agentStatus().then(heard)}
            saveToken={(token) => env.saveClaudeToken(token).then(heard)}
            onLanded={() => void finish("claude", "subscription")}
            next="This page moves on once it's connected."
          />
        ))}
      {method === "api-key" &&
        (isConnected ? (
          <Connected detail={agent === "claude" ? "Anthropic API key" : "OpenAI API key"} />
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {agent === "claude" ? "Sessions run Claude Code on your Anthropic API key." : "Sessions run Codex on your OpenAI API key."}
            </p>
            <SecretForm
              placeholder={agent === "claude" ? "sk-ant-api…" : "sk-…"}
              onSave={(key) => env.saveApiKey(agent === "claude" ? "anthropic" : "openai", key).then(onStatus)}
            />
          </div>
        ))}
      {method === "outrunner" && (
        <div className="border-border/60 space-y-1 rounded-xl border p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="size-4" /> {freeModelsOffer()}
          </p>
          <p className="text-muted-foreground text-sm">
            {`Sessions run ${AGENT_NAMES[agent]} on Outrunner's models (GLM, Kimi, DeepSeek), nothing to connect. `}
            Add your own {AGENT_NAMES[agent]} any time in Settings → Providers.
          </p>
        </div>
      )}

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="flex justify-end">
        <LoadingButton
          size="default"
          status={busy ? "pending" : "idle"}
          disabled={method !== "outrunner" && !isConnected}
          onClick={() => void finish(agent, method)}
          labels={{ idle: "Continue", pending: "Saving" }}
        />
      </div>
    </Page>
  );
}

function Page({ title, onBack, children }: { title: React.ReactNode; onBack?: () => void; children: React.ReactNode }) {
  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
      {onBack && (
        <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm">
          <ArrowLeft className="size-4" /> Back
        </button>
      )}
    </section>
  );
}

/** One choice, as a row that goes on to its page. */
function Row({
  icon: Icon,
  label,
  note,
  done,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  note?: string;
  done?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-border/60 bg-card/30 hover:bg-accent/30 flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm"
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1">
        {label}
        {note && <span className="text-amber-500 ml-2 text-xs">{note}</span>}
      </span>
      {done && <span className="text-amber-500 text-xs">Connected</span>}
      <ChevronRight className="text-muted-foreground size-4" />
    </button>
  );
}

function Connected({ detail }: { detail: string }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      <span className="bg-amber-500/15 text-amber-500 flex size-5 items-center justify-center rounded-full">
        <Check className="size-3" strokeWidth={3} />
      </span>
      Connected <span className="text-muted-foreground">· {detail}</span>
    </p>
  );
}
