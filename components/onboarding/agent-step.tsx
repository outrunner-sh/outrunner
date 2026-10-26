"use client";

import { ArrowLeft, Check, ChevronRight, Copy, KeyRound, Sparkles, Terminal } from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";

import { ClaudeIcon, OpenAIIcon } from "@/components/brand-icons";
import { ClaudeConnection } from "@/components/claude-connection";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { freeModelsOffer } from "@/lib/onboarding/rules";
import type { AgentPick, AgentStatus, OnboardingEnv } from "@/lib/onboarding/types";
import { cn } from "@/lib/utils";

/** How often the page looks for a subscription connected from the terminal. */
const TERMINAL_POLL_MS = 3_000;

type Agent = "claude" | "codex";
type Method = "subscription" | "api-key" | "outrunner";

/** Where in the step the user is: the agents, one agent's ways to connect,
 *  or one way's page. */
type Page = { at: "agents" } | { at: "methods"; agent: Agent } | { at: "connect"; agent: Agent; method: Method };

const AGENT_NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "OpenAI Codex" };
const AGENT_ICONS: Record<Agent, ComponentType<{ className?: string }>> = { claude: ClaudeIcon, codex: OpenAIIcon };

/** The CLI that connects Claude from the user's terminal, by package manager
 *  (it signs the terminal in, then runs `claude setup-token`). */
const CONNECT_COMMANDS = [
  ["npm", "npx outrunner@latest"],
  ["pnpm", "pnpm dlx outrunner@latest"],
  ["yarn", "yarn dlx outrunner@latest"],
  ["bun", "bunx outrunner@latest"],
] as const;

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
        onDone("outrunner");
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

  if (page.at === "agents") {
    return (
      <Page title="Choose a coding agent">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(["claude", "codex"] as const).map((agent) => (
            <Row key={agent} icon={AGENT_ICONS[agent]} label={AGENT_NAMES[agent]} onClick={() => setPage({ at: "methods", agent })} />
          ))}
        </div>
      </Page>
    );
  }

  const { agent } = page;
  const Icon = AGENT_ICONS[agent];
  const title = (
    <>
      Connect <Icon className="mx-1.5 inline size-5 align-[-3px]" /> <span className="font-normal">{AGENT_NAMES[agent]}</span>
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
              note: agent === "codex" ? `${freeModelsOffer()} · runs in Claude Code` : freeModelsOffer(),
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
            meta={{ connected: false, last4: null }}
            onChange={(meta) => {
              void env.agentStatus().then(onStatus, () => {});
              if (meta.connected) void finish("claude", "subscription");
            }}
          />
        ) : (
          <SubscriptionFromTerminal env={env} onStatus={onStatus} onConnected={() => void finish("claude", "subscription")} />
        ))}
      {method === "api-key" &&
        (isConnected ? (
          <Connected detail={agent === "claude" ? "Anthropic API key" : "OpenAI API key"} />
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {agent === "claude" ? "Sessions run Claude Code on your Anthropic API key." : "Sessions run Codex on your OpenAI API key."}
            </p>
            <KeyForm
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
            Sessions run {agent === "codex" ? "in Claude Code " : ""}on Outrunner&apos;s models (GLM, Kimi, DeepSeek), nothing to
            connect. Add your own {AGENT_NAMES[agent]} any time in Settings → Providers.
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
        {note && <span className="text-success ml-2 text-xs">{note}</span>}
      </span>
      {done && <span className="text-success text-xs">Connected</span>}
      <ChevronRight className="text-muted-foreground size-4" />
    </button>
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

/** The CLI command to connect the subscription from the user's terminal, by
 *  package manager, as Replicas shows it; the page moves on once it lands. A
 *  token from `claude setup-token` can be pasted instead. */
function SubscriptionFromTerminal({
  env,
  onStatus,
  onConnected,
}: {
  env: OnboardingEnv;
  onStatus: (status: AgentStatus) => void;
  /** The subscription landed: the step goes on. */
  onConnected: () => void;
}) {
  const [manager, setManager] = useState(0);
  const [pasting, setPasting] = useState(false);
  const [copied, setCopied] = useState(false);
  const command = CONNECT_COMMANDS[manager][1];

  // Called once, though the poll and a pasted token can both see the
  // subscription land; the poll reads the latest callback through `land`.
  const went = useRef(false);
  const landed = (status: AgentStatus) => {
    onStatus(status);
    if (status.claude.subscription && !went.current) {
      went.current = true;
      onConnected();
    }
  };
  const land = useRef(landed);
  useEffect(() => {
    land.current = landed;
  });

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) env.agentStatus().then((status) => land.current(status), () => {});
    }, TERMINAL_POLL_MS);
    return () => clearInterval(timer);
  }, [env]);

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">Run the CLI and connect your Claude Code account</p>
      <div role="tablist" aria-label="Package manager" className="flex gap-4 text-xs">
        {CONNECT_COMMANDS.map(([name], index) => (
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
        <Terminal className="text-success size-3.5 shrink-0" />
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
      <p className="text-muted-foreground text-xs">Claude will give you a code to paste into your terminal. This page moves on once it&apos;s connected.</p>
      {pasting ? (
        <KeyForm placeholder="Paste the token from claude setup-token" onSave={(token) => env.saveClaudeToken(token).then(landed)} />
      ) : (
        <button type="button" onClick={() => setPasting(true)} className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline">
          Or paste a token from <code className="font-mono">claude setup-token</code>
        </button>
      )}
    </div>
  );
}

function KeyForm({ placeholder, onSave }: { placeholder: string; onSave: (value: string) => Promise<unknown> }) {
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
