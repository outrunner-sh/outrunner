"use client";

import { useEffect, useState } from "react";

import { SkeletonRows, SkeletonSwap } from "@/components/ui/skeleton-swap";
import { codexModels, type CodexModel } from "@/lib/desktop/local-runtime";
import { isDesktopApp } from "@/lib/is-desktop";
import { NO_DEFAULTS, type LocalAgent, type SessionDefaults } from "@/lib/runtime/session-defaults";
import { fetchSessionDefaults, saveSessionDefaults } from "@/lib/runtime/session-defaults-client";
import { CLAUDE_MODELS, DEFAULT_CLOUD_MODEL, NEEV_AI_MODELS } from "@/lib/runtime/session-models";

const SELECT =
  "h-9 w-full rounded-md border border-border/60 bg-background px-2.5 text-sm text-foreground disabled:opacity-60";

type Save = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "error"; message: string };

/**
 * Settings → Models: what a new session starts on. On this Mac, the agent
 * (Claude Code or Codex) and its model; in the cloud, the model. Each session
 * can still switch from its composer. Saved as soon as it changes.
 */
export function SessionDefaultsSettings() {
  const [defaults, setDefaults] = useState<SessionDefaults | null>(null);
  const [save, setSave] = useState<Save>({ state: "idle" });
  // Codex's models, as Codex lists them for the Mac's login; null outside the
  // Mac app or until they're in.
  const [codex, setCodex] = useState<CodexModel[] | null>(null);
  const desktop = isDesktopApp();

  useEffect(() => {
    let live = true;
    void fetchSessionDefaults().then((loaded) => {
      if (live) setDefaults(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  const wantsCodexModels = desktop && defaults?.local.agent === "codex";
  useEffect(() => {
    if (!wantsCodexModels) return;
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
  }, [wantsCodexModels]);

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
              <p className="text-xs text-muted-foreground">Sessions in a folder on your Mac, in the Outrunner app.</p>
            </div>
            <fieldset className="space-y-2">
              <legend className="sr-only">Agent</legend>
              {(
                [
                  ["claude", "Claude Code", "Anthropic's agent, on your Claude login"],
                  ["codex", "Codex", "OpenAI's agent, on your ChatGPT login"],
                ] as const
              ).map(([value, label, detail]) => (
                <label key={value} className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="radio"
                    name="local-agent"
                    className="mt-1"
                    checked={current.local.agent === value}
                    onChange={() => setAgent(value)}
                  />
                  <span>
                    <span className="block text-foreground">{label}</span>
                    <span className="block text-xs text-muted-foreground">{detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="block space-y-1.5">
              <span className="text-xs text-muted-foreground">Model</span>
              {current.local.agent === "claude" ? (
                <select className={SELECT} value={current.local.model ?? ""} onChange={(e) => setLocalModel(e.target.value)}>
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
                  disabled={!desktop || codex === null}
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
              {current.local.agent === "codex" && !desktop && (
                <span className="block text-xs text-muted-foreground">
                  Codex&apos;s models come from Codex on your Mac: choose one in the Outrunner app.
                </span>
              )}
            </label>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 p-4">
            <div>
              <h2 className="text-sm font-medium text-foreground">In the cloud</h2>
              <p className="text-xs text-muted-foreground">
                Sessions on a cloud computer. A Claude account model needs Claude connected.
              </p>
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
                <optgroup label="Claude account">
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
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
