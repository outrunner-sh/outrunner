"use client";

import { useState } from "react";

import { ApiKeyCard, type ProviderKeys } from "@/components/api-key-card";
import { AuthMethodCards } from "@/components/auth-method-cards";
import { ClaudeConnection } from "@/components/claude-connection";
import { LocalAgentConnection } from "@/components/local-agent-connection";
import { SectionHeader } from "@/components/settings-details";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { AGENTS, type AgentId, type AuthCredential, type AuthMethodId, authMethod } from "@/lib/agents/registry";
import { AGENT_AUTH_CHOICES } from "@/lib/client/agent-auth-choices";
import type { AgentAuthChoices } from "@/lib/db/credentials";
import { requestJson } from "@/lib/http/request-json";
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

  function show(method: AuthMethodId) {
    setShown(method);
    // A save still under way keeps its error slot for its own reply.
    if (!saving) setError(null);
  }

  async function choose(method: AuthMethodId) {
    if (method === chosen) return;
    setSaving(true);
    try {
      const data = await requestJson<{ choices: AgentAuthChoices }>("/api/settings/agents", {
        method: "PUT",
        body: { agent, method },
        has: (d) => d.choices !== undefined,
      });
      AGENT_AUTH_CHOICES.invalidate();
      // This agent's only: another tab's reply, sent before a pick there
      // landed, mustn't undo it.
      onChoice(agent, data.choices[agent]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  const way = authMethod(agent, shown)!;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionHeader title="Authentication" />
        <AuthMethodCards
          methods={methods}
          chosen={chosen}
          shown={shown}
          busy={saving}
          onChoose={show}
          label={`How ${label} signs in`}
        />
        <p className="text-[13px] text-muted-foreground">
          {chosen ? way.description : `Choose how ${label} signs in for your sessions. ${way.description}`}
        </p>
        {shown !== chosen ? (
          <LoadingButton
            variant="outline"
            status={saving ? "pending" : "idle"}
            labels={{ idle: `Use ${way.label}`, pending: "Saving" }}
            onClick={() => void choose(shown)}
          />
        ) : null}
        {error ? (
          <InlineMessage>{error}</InlineMessage>
        ) : null}
      </div>

      {/* Every card's details stay mounted, so a sign-in under way (a login
          the Mac app is running, a code being pasted) keeps its controls
          through a look at another card. */}
      {methods.map(({ id, credential }) => (
        <div key={id} hidden={id !== shown}>
          {credential.kind === "claude-slot" ? (
            <ClaudeConnection meta={claude} onChange={onClaude} />
          ) : credential.kind === "provider-key" ? (
            <ApiKeyCard
              provider={credential.provider}
              stored={keys[credential.provider]}
              onChange={(next) => onKeys(next, credential.provider)}
            />
          ) : (
            <LocalAgentConnection agent={agent} chatgpt={id === "chatgpt"} shown={id === shown} />
          )}
        </div>
      ))}
    </div>
  );
}
