"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { SkeletonRows, SkeletonSwap } from "@/components/ui/skeleton-swap";
import { useClaudeLocalLogin, useLocalRuntime, type ClaudeLogin } from "@/hooks/use-local-runtime";
import {
  claudeSetupText,
  codexModels,
  needsClaudeLogin,
  needsCodexLogin,
  setUpCodex,
  supportsCodex,
  type CodexModel,
  type LocalStatus,
} from "@/lib/desktop/local-runtime";
import { NO_DEFAULTS, type LocalAgent, type SessionDefaults } from "@/lib/runtime/session-defaults";
import { fetchSessionDefaults, saveSessionDefaults } from "@/lib/runtime/session-defaults-client";
import { CLAUDE_MODELS, DEFAULT_CLOUD_MODEL, NEEV_AI_MODELS } from "@/lib/runtime/session-models";
import { cn } from "@/lib/utils";

const SELECT =
  "h-9 w-full rounded-md border border-border/60 bg-background px-2.5 text-sm text-foreground disabled:opacity-60";

type Save = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "error"; message: string };

/** Where an agent stands on this Mac: only a connected one can be chosen. */
type AgentReadiness =
  | { state: "ready" }
  | { state: "checking" }
  /** Not in the Mac app, or an app too old for it. */
  | { state: "unavailable"; reason: string }
  | { state: "setting-up"; text: string }
  | { state: "needs-setup"; text?: string }
  | { state: "needs-login" };

function claudeReadiness(status: LocalStatus | null): AgentReadiness {
  if (!status) return { state: "checking" };
  if (!status.claude) return { state: "unavailable", reason: "Claude Code isn't set up on this Mac yet." };
  return needsClaudeLogin(status) ? { state: "needs-login" } : { state: "ready" };
}

function codexReadiness(status: LocalStatus | null): AgentReadiness {
  if (!status) return { state: "checking" };
  if (!supportsCodex(status)) return { state: "unavailable", reason: "Update the Outrunner app to use Codex." };
  if (!status.codex) {
    return status.codexSetup?.state === "installing"
      ? { state: "setting-up", text: claudeSetupText(status.codexSetup, "Codex") }
      : { state: "needs-setup", text: status.codexSetup?.state === "failed" ? status.codexSetup.message : undefined };
  }
  return needsCodexLogin(status) ? { state: "needs-login" } : { state: "ready" };
}

/**
 * Settings → Models: what a new session starts on. On this Mac, the agent
 * (Claude Code or Codex) and its model; in the cloud, the model. Each session
 * can still switch from its composer. Saved as soon as it changes.
 *
 * Only what is connected can be chosen: an agent not logged in on this Mac
 * offers its login (and Codex its setup) instead, and Claude account models
 * in the cloud need Claude connected.
 */
export function SessionDefaultsSettings() {
  const [defaults, setDefaults] = useState<SessionDefaults | null>(null);
  const [save, setSave] = useState<Save>({ state: "idle" });
  const { runtime, recheck } = useLocalRuntime();
  const claudeLogin = useClaudeLocalLogin(recheck);
  const codexLogin = useClaudeLocalLogin(recheck, "codex");
  // Whether the user's Claude is connected, for the cloud's Claude models.
  const [claudeConnected, setClaudeConnected] = useState<boolean | null>(null);
  // Codex's models, as Codex lists them for the Mac's login.
  const [codex, setCodex] = useState<CodexModel[] | null>(null);

  useEffect(() => {
    let live = true;
    void fetchSessionDefaults().then((loaded) => {
      if (live) setDefaults(loaded);
    });
    void fetch("/api/settings/claude")
      .then((res) => (res.ok ? (res.json() as Promise<{ connected?: boolean }>) : {}))
      .then((body) => live && setClaudeConnected(Boolean((body as { connected?: boolean }).connected)))
      .catch(() => live && setClaudeConnected(false));
    return () => {
      live = false;
    };
  }, []);

  const status = runtime.state === "ready" ? runtime.status : null;
  const inApp = runtime.state !== "unavailable";
  const claude: AgentReadiness = inApp
    ? claudeReadiness(status)
    : { state: "unavailable", reason: "Open the Outrunner app to set this up." };
  const codexState: AgentReadiness = inApp
    ? codexReadiness(status)
    : { state: "unavailable", reason: "Open the Outrunner app to set this up." };

  const codexReady = codexState.state === "ready";
  useEffect(() => {
    if (!codexReady) return;
    let live = true;
    codexModels()
      .then((models) => {
        if (live) setCodex(models);
      })
      .catch(() => {
        if (live) setCodex([]);
      });
    return () => {
      live = false;
    };
  }, [codexReady]);

  const update = (next: SessionDefaults) => {
    setDefaults(next);
    setSave({ state: "saving" });
    saveSessionDefaults(next).then(
      (saved) => {
        setDefaults(saved);
        setSave({ state: "saved" });
      },
      (error: unknown) => setSave({ state: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  };

  const current = defaults ?? NO_DEFAULTS;
  const setAgent = (agent: LocalAgent) => update({ ...current, local: { agent, model: null } });
  const setLocalModel = (model: string) => update({ ...current, local: { ...current.local, model: model || null } });
  const setCloudModel = (model: string) => update({ ...current, cloud: { model: model || null } });
  const chosen = current.local.agent === "codex" ? codexState : claude;

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Models</h1>
        <p className="text-sm text-muted-foreground">
          What a new session starts on. Any session can still switch from its composer.
        </p>
      </div>

      <SkeletonSwap ready={defaults !== null} skeleton={<SkeletonRows rows={3} rowHeight={36} />}>
        <div className="space-y-4">
          <div className="space-y-3 rounded-lg border border-border/60 p-4">
            <div>
              <h2 className="text-sm font-medium text-foreground">On this Mac</h2>
              <p className="text-xs text-muted-foreground">
                Sessions in a folder on your Mac. Connect an agent here to choose it.
              </p>
            </div>
            <fieldset className="space-y-2.5">
              <legend className="sr-only">Agent</legend>
              <AgentOption
                label="Claude Code"
                detail="Anthropic's agent, on your Claude login"
                readiness={claude}
                selected={current.local.agent === "claude"}
                onSelect={() => setAgent("claude")}
                login={claudeLogin}
              />
              <AgentOption
                label="Codex"
                detail="OpenAI's agent, on your ChatGPT login"
                readiness={codexState}
                selected={current.local.agent === "codex"}
                onSelect={() => setAgent("codex")}
                login={codexLogin}
                onSetUp={() => void setUpCodex().catch(() => {}).then(recheck)}
              />
            </fieldset>
            <label className="block space-y-1.5">
              <span className="text-xs text-muted-foreground">Model</span>
              {current.local.agent === "claude" ? (
                <select
                  className={SELECT}
                  value={current.local.model ?? ""}
                  disabled={chosen.state !== "ready"}
                  onChange={(e) => setLocalModel(e.target.value)}
                >
                  <option value="">Claude Code&apos;s default</option>
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  className={SELECT}
                  value={current.local.model ?? ""}
                  disabled={chosen.state !== "ready" || codex === null}
                  onChange={(e) => setLocalModel(e.target.value)}
                >
                  <option value="">Codex&apos;s default for your login</option>
                  {/* The saved one stays listed even when Codex no longer offers it. */}
                  {current.local.model && !codex?.some((m) => m.id === current.local.model) && (
                    <option value={current.local.model}>{current.local.model}</option>
                  )}
                  {(codex ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName || m.id}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 p-4">
            <div>
              <h2 className="text-sm font-medium text-foreground">In the cloud</h2>
              <p className="text-xs text-muted-foreground">Sessions on a cloud computer.</p>
            </div>
            <label className="block space-y-1.5">
              <span className="text-xs text-muted-foreground">Model</span>
              <select className={SELECT} value={current.cloud.model ?? ""} onChange={(e) => setCloudModel(e.target.value)}>
                <option value="">Outrunner&apos;s default ({DEFAULT_CLOUD_MODEL.label})</option>
                <optgroup label="Outrunner">
                  {NEEV_AI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={claudeConnected ? "Claude account" : "Claude account (connect Claude first)"}>
                  {CLAUDE_MODELS.map((m) => (
                    // A saved one stays selectable-looking so the choice isn't hidden.
                    <option key={m.id} value={m.id} disabled={!claudeConnected && current.cloud.model !== m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            {claudeConnected === false && (
              <p className="text-xs text-muted-foreground">
                To start cloud sessions on your Claude account&apos;s models,{" "}
                <Link href="/settings/claude" className="font-medium text-foreground underline underline-offset-4">
                  connect Claude
                </Link>{" "}
                first.
              </p>
            )}
          </div>

          <p aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
            {save.state === "saving"
              ? "Saving…"
              : save.state === "saved"
                ? "Saved."
                : save.state === "error"
                  ? save.message
                  : ""}
          </p>
        </div>
      </SkeletonSwap>
    </section>
  );
}

/**
 * One agent: chosen with its radio once connected; until then its login (or,
 * for Codex, its setup) is offered in its place.
 */
function AgentOption({
  label,
  detail,
  readiness,
  selected,
  onSelect,
  login,
  onSetUp,
}: {
  label: string;
  detail: string;
  readiness: AgentReadiness;
  selected: boolean;
  onSelect: () => void;
  login: { login: ClaudeLogin; start: () => Promise<void>; cancel: () => void };
  onSetUp?: () => void;
}) {
  const ready = readiness.state === "ready";
  const note =
    readiness.state === "checking"
      ? "Checking this Mac…"
      : readiness.state === "unavailable"
        ? readiness.reason
        : readiness.state === "setting-up"
          ? readiness.text
          : readiness.state === "needs-setup"
            ? (readiness.text ?? `${label} isn't set up on this Mac yet.`)
            : readiness.state === "needs-login"
              ? login.login.state === "waiting"
                ? "Approve the login in your browser…"
                : login.login.state === "error"
                  ? login.login.message
                  : `Log in to ${label} to choose it.`
              : null;
  return (
    <div className="flex items-start gap-2.5">
      <input
        type="radio"
        name="local-agent"
        aria-label={label}
        className="mt-1"
        checked={selected}
        disabled={!ready}
        onChange={onSelect}
      />
      <div className="min-w-0 flex-1">
        <span className={cn("block text-sm", ready ? "text-foreground" : "text-muted-foreground")}>
          {label}
          {ready && <span className="ml-2 text-xs text-success">Connected</span>}
        </span>
        <span className="block text-xs text-muted-foreground">{note ?? detail}</span>
      </div>
      {readiness.state === "needs-login" &&
        (login.login.state === "waiting" ? (
          <Button size="sm" variant="ghost" onClick={login.cancel}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void login.start()}>
            {login.login.state === "error" ? "Try again" : "Log in"}
          </Button>
        ))}
      {readiness.state === "needs-setup" && onSetUp && (
        <Button size="sm" variant="outline" onClick={onSetUp}>
          {readiness.text ? "Try again" : `Set up ${label}`}
        </Button>
      )}
    </div>
  );
}
