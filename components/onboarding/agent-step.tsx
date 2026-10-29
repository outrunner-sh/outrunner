"use client";

import { ArrowLeft, Check, ChevronRight, KeyRound, Sparkles } from "lucide-react";
import { type ComponentType, useState } from "react";

import { AgentIcon, ClaudeIcon } from "@/components/brand-icons";
import { ClaudeConnection } from "@/components/claude-connection";
import { ClaudeFromTerminal } from "@/components/claude-from-terminal";
import { DashedCard, DashedPanel, DashedRule } from "@/components/onboarding/dashed";
import { LoadingButton } from "@/components/ui/loading-button";
import { SecretForm } from "@/components/ui/secret-form";
import { freeModelsOffer } from "@/lib/onboarding/rules";
import type { AgentPick, AgentStatus, OnboardingEnv } from "@/lib/onboarding/types";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
import { cn } from "@/lib/utils";

type Agent = "claude" | "codex";
type Method = "subscription" | "api-key" | "outrunner";

/** Where in the step the user is: the agents, one agent's ways to connect,
 *  or one way's page. */
type Page = { at: "agents" } | { at: "methods"; agent: Agent } | { at: "connect"; agent: Agent; method: Method };

const AGENT_NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "OpenAI Codex" };
const AGENT_MAKERS: Record<Agent, string> = { claude: "Anthropic", codex: "OpenAI" };

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(["claude", "codex"] as const).map((agent) => (
            <AgentCard
              key={agent}
              agent={agent}
              done={agent === "claude" ? status.claude.subscription || status.claude.apiKey : status.codex.apiKey}
              onClick={() => setPage({ at: "methods", agent })}
            />
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
    return (
      <Page title={title} onBack={() => setPage({ at: "agents" })}>
        <div className="space-y-3">
          {methodsOf(agent, env.outrunnerModels).map((method) => (
            <MethodCard
              key={method}
              info={methodInfo(agent, method)}
              done={connected(agent, method, status)}
              onClick={() => setPage({ at: "connect", agent, method })}
            />
          ))}
        </div>
      </Page>
    );
  }

  const { method } = page;
  const isConnected = connected(agent, method, status);
  return (
    <Page
      title={title}
      onBack={() => setPage({ at: "methods", agent })}
      action={
        <LoadingButton
          size="default"
          status={busy ? "pending" : "idle"}
          disabled={method !== "outrunner" && !isConnected}
          onClick={() => void finish(agent, method)}
          labels={{ idle: "Continue", pending: "Saving" }}
        />
      }
    >
      <DashedPanel>
        <div className="flex items-center gap-4 px-5 py-4">
          <MethodHeading info={methodInfo(agent, method)} />
        </div>
        <DashedRule />
        <div className="px-5 py-5">
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
              <Connected detail={`${AGENT_MAKERS[agent]} API key`} />
            ) : (
              <div className="space-y-3">
                <p className="text-muted-foreground text-sm">
                  {`Sessions run ${AGENT_NAMES[agent]} on your ${AGENT_MAKERS[agent]} API key.`}
                </p>
                <SecretForm
                  placeholder={agent === "claude" ? "sk-ant-api…" : "sk-…"}
                  onSave={(key) => env.saveApiKey(agent === "claude" ? "anthropic" : "openai", key).then(onStatus)}
                />
              </div>
            ))}
          {method === "outrunner" && (
            <p className="text-muted-foreground text-sm">
              {`Sessions run ${AGENT_NAMES[agent]} on these from the start. `}
              Add your own {AGENT_NAMES[agent]} any time in Personal → Coding agents.
            </p>
          )}
        </div>
      </DashedPanel>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
    </Page>
  );
}

function Page({
  title,
  onBack,
  action,
  children,
}: {
  title: React.ReactNode;
  onBack?: () => void;
  /** What moves the step on, across from Back. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
      {(onBack || action) && (
        <div className="flex items-center justify-between">
          {onBack ? (
            <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm">
              <ArrowLeft className="size-4" /> Back
            </button>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
    </section>
  );
}

/** An icon in a small framed tile, as the cards lead with. */
function IconTile({ size, children }: { size: "sm" | "lg"; children: React.ReactNode }) {
  return (
    <span
      className={cn("border-border/60 bg-muted/30 flex shrink-0 items-center justify-center rounded-lg border", size === "lg" ? "size-11" : "size-9")}
    >
      {children}
    </span>
  );
}

/** Where a card ends: connected, or an arrow on. */
function CardEnd({ done }: { done?: boolean }) {
  return done ? (
    <span className="text-amber-500 flex shrink-0 items-center gap-1 text-xs">
      <Check className="size-3" strokeWidth={3} /> Connected
    </span>
  ) : (
    <ChevronRight className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
  );
}

/** One agent to choose, going on to its ways to connect. */
function AgentCard({ agent, done, onClick }: { agent: Agent; done: boolean; onClick: () => void }) {
  return (
    <DashedCard onClick={onClick} className="flex min-h-40 flex-col justify-between p-5">
      <span className="flex items-start justify-between">
        <IconTile size="lg">
          <AgentIcon agent={agent} className="size-6" />
        </IconTile>
        <CardEnd done={done} />
      </span>
      <span className="space-y-0.5">
        <span className="block text-base font-medium">{AGENT_NAMES[agent]}</span>
        <span className="text-muted-foreground block text-xs">{AGENT_MAKERS[agent]}&apos;s coding agent</span>
      </span>
    </DashedCard>
  );
}

type MethodInfo = { label: string; detail: string; icon: ComponentType<{ className?: string }>; note?: string };

/** The ways `agent` can connect, in the order they're offered. */
function methodsOf(agent: Agent, outrunnerModels: boolean): Method[] {
  return [...(agent === "claude" ? (["subscription"] as const) : []), "api-key", ...(outrunnerModels ? (["outrunner"] as const) : [])];
}

/** How a way to connect is named and told, on its card and its page. */
function methodInfo(agent: Agent, method: Method): MethodInfo {
  const maker = AGENT_MAKERS[agent];
  switch (method) {
    case "subscription":
      return { label: "Use a subscription", detail: "Sign in with your Claude Pro or Max plan", icon: ClaudeIcon };
    case "api-key":
      return { label: `${maker} API key`, detail: `Pay as you go on your own ${maker} key`, icon: KeyRound };
    case "outrunner":
      return { label: "Outrunner's models", detail: "GLM, Kimi and DeepSeek, nothing to connect", icon: Sparkles, note: freeModelsOffer() };
  }
}

/** A way to connect, as its icon, name, and what it is. */
function MethodHeading({ info: { icon: Icon, label, detail, note } }: { info: MethodInfo }) {
  return (
    <>
      <IconTile size="sm">
        <Icon className="size-4" />
      </IconTile>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {label}
          {note && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-normal text-amber-500">
              {note}
            </span>
          )}
        </span>
        <span className="text-muted-foreground block text-xs">{detail}</span>
      </span>
    </>
  );
}

/** One way to connect an agent, going on to its page. */
function MethodCard({ info, done, onClick }: { info: MethodInfo; done?: boolean; onClick: () => void }) {
  return (
    <DashedCard onClick={onClick} className="flex items-center gap-4 px-5 py-4">
      <MethodHeading info={info} />
      <CardEnd done={done} />
    </DashedCard>
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
