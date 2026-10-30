"use client";

import { ArrowLeft, Check, Cloud, Laptop, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentIcon } from "@/components/brand-icons";
import { ClaudeConnection } from "@/components/claude-connection";
import { CodexConnection } from "@/components/codex-connection";
import { DashedCard, DashedPanel } from "@/components/onboarding/dashed";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { SecretForm } from "@/components/ui/secret-form";
import {
  AGENTS,
  AGENT_IDS,
  type AgentId,
  type AuthMethodId,
  type RunTarget,
} from "@/lib/agents/registry";
import { agentCli } from "@/lib/desktop/local-runtime";
import type {
  AgentChoices,
  AgentPick,
  AgentStatus,
  OnboardingEnv,
} from "@/lib/onboarding/types";
import { cn } from "@/lib/utils";

function cloudConnected(
  status: AgentStatus,
  agent: AgentId,
  method: AuthMethodId,
): boolean {
  if (status.cloud?.[agent].includes(method)) return true;
  if (method === "codex-account") return status.codex.account === true;
  if (method === "subscription") return status.claude.subscription;
  return method === "api-key" && status[agent].apiKey;
}

export function DesktopAgentStep({
  env,
  status,
  choices,
  onStatus,
  onDone,
  initialTarget = "local",
}: {
  env: OnboardingEnv;
  status: AgentStatus;
  choices: AgentChoices | null;
  onStatus: (next: AgentStatus) => void;
  onDone: (pick: AgentPick, target: RunTarget) => void;
  initialTarget?: RunTarget;
}) {
  const [agent, setAgent] = useState<AgentId | null>(null);
  const [target, setTarget] = useState<RunTarget>(initialTarget);
  const [method, setMethod] = useState<AuthMethodId | "outrunner" | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<{
    controller: AbortController;
    agent: AgentId;
  } | null>(null);
  useEffect(
    () => () => {
      const attempt = current.current;
      attempt?.controller.abort();
      if (attempt) void env.cancelLogin(attempt.agent).catch(() => {});
    },
    [env],
  );

  async function refresh() {
    setError(null);
    try {
      const next = await env.agentStatus();
      onStatus(next);
      return next;
    } catch {
      setError("Couldn't check your agents. Try again.");
      return null;
    }
  }

  async function continueLocal() {
    if (!agent) return;
    const controller = new AbortController();
    current.current = { controller, agent };
    setError(null);
    try {
      let next = status;
      let cli = next.local ? agentCli(next.local, agent) : null;
      if (!cli)
        throw new Error(
          next.localError ??
            "Couldn't check the agents on this Mac. Refresh or update Outrunner and try again.",
        );
      if (!cli.path) {
        setPhase(`Preparing ${AGENTS[agent].label}…`);
        await env.setupAgent(agent);
        controller.signal.throwIfAborted();
        next = await env.agentStatus();
        onStatus(next);
        cli = next.local ? agentCli(next.local, agent) : null;
      }
      if (!cli?.path)
        throw new Error(`Couldn't prepare ${AGENTS[agent].label}. Try again.`);
      if (cli.loggedIn !== true) {
        setPhase("Approve sign-in in your browser…");
        await env.loginAgent(agent);
        controller.signal.throwIfAborted();
        next = await env.agentStatus();
        onStatus(next);
        cli = next.local ? agentCli(next.local, agent) : null;
      }
      if (cli?.loggedIn !== true)
        throw new Error(
          "Sign-in couldn't be confirmed. Refresh to check again.",
        );
      controller.signal.throwIfAborted();
      setPhase("Saving your choice…");
      await env.chooseMethod(agent, "local");
      if (!controller.signal.aborted) onDone(agent, "local");
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current.current?.controller === controller) {
        current.current = null;
        setPhase(null);
      }
    }
  }

  async function continueCloud(chosen: AuthMethodId | "outrunner") {
    if (!agent) return;
    setPhase("Saving your choice…");
    setError(null);
    try {
      if (chosen === "outrunner")
        onDone(agent === "codex" ? "codex-outrunner" : "outrunner", "cloud");
      else {
        await env.chooseMethod(agent, chosen);
        onDone(agent, "cloud");
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't save your choice. Try again.",
      );
    } finally {
      setPhase(null);
    }
  }

  if (!agent)
    return (
      <section className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Choose a coding agent</h1>
          <p className="text-muted-foreground text-sm">
            We checked this Mac for agents you already use.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {AGENT_IDS.map((id) => {
            const cli = status.local ? agentCli(status.local, id) : null;
            return (
              <DashedCard
                key={id}
                onClick={() => {
                  setAgent(id);
                  setMethod(null);
                  setError(null);
                }}
              >
                <span className="flex min-h-36 flex-col justify-between p-5">
                  <AgentIcon agent={id} className="size-7" />
                  <span>
                    <span className="block font-medium">
                      {AGENTS[id].label}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {!cli
                        ? "Check this Mac"
                        : !cli.path
                          ? "We'll set it up for you"
                          : cli.loggedIn === true
                            ? "Detected · Signed in"
                            : cli.loggedIn === false
                              ? "Detected · Sign-in needed"
                              : "Detected · Check sign-in"}
                    </span>
                  </span>
                </span>
              </DashedCard>
            );
          })}
        </div>
        {status.localError && (
          <p role="alert" className="text-destructive text-sm">
            {status.localError}
          </p>
        )}
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="size-3.5" />
          Check again
        </Button>
      </section>
    );

  const cli = status.local ? agentCli(status.local, agent) : null;
  const cloudMethods = AGENTS[agent].methods.filter((m) =>
    m.targets.includes("cloud"),
  );
  const saved = choices?.[agent];
  const defaultMethod =
    cloudMethods.find((m) => m.id === saved)?.id ??
    cloudMethods.find((m) => cloudConnected(status, agent, m.id))?.id ??
    cloudMethods[0].id;
  const selected = method ?? defaultMethod;
  return (
    <section className="space-y-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <AgentIcon agent={agent} className="size-5" />
        {AGENTS[agent].label}
      </h1>
      <div
        role="group"
        aria-label="Where to run"
        className="grid grid-cols-2 gap-3"
      >
        {(
          [
            ["local", "On this Mac", Laptop],
            ["cloud", "In the cloud", Cloud],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            disabled={phase !== null}
            aria-pressed={target === id}
            onClick={() => {
              setTarget(id);
              setError(null);
            }}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm transition-colors",
              target === id
                ? "border-foreground/50 bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>
      {target === "local" ? (
        <DashedPanel>
          <div className="space-y-4 p-5">
            <p className="text-sm">
              {cli?.loggedIn === true ? (
                <span className="flex items-center gap-2">
                  <Check className="size-4 text-amber-500" />
                  {AGENTS[agent].label} is ready on this Mac.
                </span>
              ) : cli?.path ? (
                "Approve sign-in in your browser. Outrunner will detect when it's done."
              ) : (
                "Outrunner will prepare the agent and open sign-in for you."
              )}
            </p>
            <p className="text-muted-foreground text-sm">
              Your code and agent login stay on this Mac. Choose a folder next.
            </p>
            <LoadingButton
              status={phase ? "pending" : "idle"}
              disabled={!cli}
              labels={{
                idle:
                  cli?.loggedIn === true
                    ? `Continue with ${AGENTS[agent].label}`
                    : !cli?.path
                      ? "Set up and continue"
                      : "Sign in and continue",
                pending: phase ?? "Connecting",
              }}
              onClick={() => void continueLocal()}
            />
            {phase && phase !== "Saving your choice…" && (
              <Button
                variant="ghost"
                onClick={() => {
                  current.current?.controller.abort();
                  void env.cancelLogin(agent).catch(() => {});
                  setPhase(null);
                }}
              >
                Cancel
              </Button>
            )}
            {!cli && (
              <Button variant="ghost" onClick={() => void refresh()}>
                Check again
              </Button>
            )}
          </div>
        </DashedPanel>
      ) : (
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Run while your Mac is offline. Connect a personal account, use an
            available organization connection, or choose an API key.
          </p>
          <div className="flex flex-wrap gap-2">
            {cloudMethods.map((m) => (
              <Button
                key={m.id}
                variant={selected === m.id ? "secondary" : "outline"}
                disabled={phase !== null}
                onClick={() => setMethod(m.id)}
              >
                {m.label}
              </Button>
            ))}
            {env.outrunnerModels && (
              <Button
                variant={selected === "outrunner" ? "secondary" : "outline"}
                onClick={() => setMethod("outrunner")}
              >
                Outrunner models
              </Button>
            )}
          </div>
          <DashedPanel>
            <div className="space-y-4 p-5">
              {selected === "outrunner" ? (
                <p className="text-muted-foreground text-sm">
                  Nothing to connect. Start with Outrunner&apos;s models.
                </p>
              ) : cloudConnected(status, agent, selected) ? (
                <p className="flex items-center gap-2 text-sm">
                  <Check className="size-4 text-amber-500" />
                  Connected and ready for cloud sessions.
                </p>
              ) : selected === "subscription" ? (
                <ClaudeConnection
                  meta={{ connected: false, last4: null, updatedAt: null }}
                  onChange={() => {
                    void refresh();
                  }}
                />
              ) : selected === "codex-account" ? (
                <CodexConnection
                  onConnected={(connected) => {
                    if (connected)
                      onStatus({
                        ...status,
                        codex: { ...status.codex, account: true },
                      });
                    else void refresh();
                  }}
                />
              ) : (
                <SecretForm
                  placeholder={agent === "claude" ? "sk-ant-api…" : "sk-…"}
                  onSave={(key) =>
                    env
                      .saveApiKey(
                        agent === "claude" ? "anthropic" : "openai",
                        key,
                      )
                      .then(onStatus)
                  }
                />
              )}
              <LoadingButton
                disabled={
                  selected !== "outrunner" &&
                  !cloudConnected(status, agent, selected)
                }
                status={phase ? "pending" : "idle"}
                labels={{ idle: "Continue", pending: "Saving" }}
                onClick={() => void continueCloud(selected)}
              />
            </div>
          </DashedPanel>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={phase !== null}
        onClick={() => setAgent(null)}
      >
        <ArrowLeft className="size-3.5" />
        Back
      </Button>
    </section>
  );
}
