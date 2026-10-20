"use client";

import { useState } from "react";

import { ApiKeyCard, type ProviderKeys } from "@/components/api-key-card";
import { AuthMethodCards } from "@/components/auth-method-cards";
import { ClaudeConnection } from "@/components/claude-connection";
import { LocalAgentConnection } from "@/components/local-agent-connection";
import { SectionHeader } from "@/components/settings-details";
import { AGENTS, type AgentId, type AuthCredential, type AuthMethodId, authMethod } from "@/lib/agents/registry";
import type { AgentAuthChoices } from "@/lib/db/credentials";
import type { KeyProviderId } from "@/lib/providers/registry";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";

/** Whether a credential is saved with Outrunner. An own login isn't: only the
 *  Mac app can say (LocalAgentConnection). */
export function savedCredential(credential: AuthCredential, keys: ProviderKeys, claude: ClaudeTokenMeta): boolean {
  if (credential.kind === "claude-slot") return claude.connected;
  if (credential.kind === "provider-key") return keys[credential.provider].connected;
  return false;
}

/**
 * One agent's tab of Settings → Providers: its ways of signing in, a card
 * each, and below them the details of the one shown. Choosing a card picks it
 * for the agent's sessions (PUT /api/settings/agents).
 */
export function AgentAuthPanel({
  agent,
  choices,
  keys,
  claude,
  initialMethod,
  onChoice,
  onKeys,
  onClaude,
}: {
  agent: AgentId;
  choices: AgentAuthChoices;
  keys: ProviderKeys;
  claude: ClaudeTokenMeta;
  /** The card a link asked to show, if any. */
  initialMethod?: AuthMethodId;
  /** A pick's reply: this agent's pick as the server now has it. */
  onChoice: (agent: AgentId, method: AuthMethodId | null) => void;
  /** A key card's reply: every key's status, and whose key it changed. */
  onKeys: (keys: ProviderKeys, provider: KeyProviderId) => void;
  onClaude: (meta: ClaudeTokenMeta) => void;
}) {
  const { label, methods } = AGENTS[agent];
  const chosen = choices[agent];
  // Shows what a link asked for, else the pick, else the first way already
  // saved here, else the first card.
  const [shown, setShown] = useState<AuthMethodId>(
    () =>
      initialMethod ??
      chosen ??
      methods.find((method) => savedCredential(method.credential, keys, claude))?.id ??
      methods[0].id,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(method: AuthMethodId) {
    setShown(method);
    if (method === chosen) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, method }),
      });
      const data = (await res.json().catch(() => null)) as { choices?: AgentAuthChoices; error?: string } | null;
      if (!res.ok || !data?.choices) throw new Error(data?.error ?? "Couldn't save that. Try again.");
      // This agent's only: another tab's reply, sent before a pick there
      // landed, mustn't undo it.
      onChoice(agent, data.choices[agent]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  const way = authMethod(agent, shown)!;
  const keyProvider = way.credential.kind === "provider-key" ? way.credential.provider : null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionHeader title="Authentication" />
        <AuthMethodCards
          methods={methods}
          chosen={chosen}
          shown={shown}
          busy={saving}
          onChoose={(method) => void choose(method)}
          label={`How ${label} signs in`}
        />
        <p className="text-sm text-muted-foreground">
          {chosen ? way.description : `Choose how ${label} signs in for your sessions. ${way.description}`}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      {way.credential.kind === "claude-slot" ? (
        <ClaudeConnection meta={claude} onChange={onClaude} />
      ) : keyProvider ? (
        <ApiKeyCard provider={keyProvider} stored={keys[keyProvider]} onChange={(next) => onKeys(next, keyProvider)} />
      ) : (
        <LocalAgentConnection agent={agent} chatgpt={shown === "chatgpt"} />
      )}
    </div>
  );
}
