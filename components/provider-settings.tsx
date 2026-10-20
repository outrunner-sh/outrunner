"use client";

import { useState } from "react";

import { AgentAuthPanel, savedCredential } from "@/components/agent-auth-panel";
import { ApiKeyCard, type ProviderKeys } from "@/components/api-key-card";
import { SettingsTabs } from "@/components/settings-tabs";
import { AGENT_IDS, AGENTS, type AgentId, isAgentId } from "@/lib/agents/registry";
import type { AgentAuthChoices } from "@/lib/db/credentials";
import { forgetOutrunnerModels } from "@/lib/desktop/local-runtime";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
import { PROVIDERS } from "@/lib/providers/registry";
import { GATEWAY_TABS, type GatewayTab, type ProviderPlace, type ProviderTab } from "@/lib/settings-links";

/** What Settings → Providers shows. */
export type ProviderSettings = { keys: ProviderKeys; choices: AgentAuthChoices; claude: ClaudeTokenMeta };

/**
 * Settings → Providers (BYOK): how each coding agent signs in, a tab per agent
 * with a card per way (lib/agents/registry.ts), then the user's own keys for
 * the model providers Claude Code runs through, a tab each
 * (lib/providers/registry.ts). Models on them are billed by the provider, not
 * counted against the user's Outrunner plan.
 */
export function ProviderSettingsForm({ initial, place }: { initial: ProviderSettings; place?: ProviderPlace }) {
  const [keys, setKeys] = useState(initial.keys);
  const [choices, setChoices] = useState(initial.choices);
  const [claude, setClaude] = useState(initial.claude);

  // Whether an agent runs on something saved here: its pick, or with none,
  // any way it has.
  const agentConnected = (agent: AgentId) => {
    const methods = AGENTS[agent].methods.filter((method) => !choices[agent] || method.id === choices[agent]);
    return methods.some((method) => savedCredential(method.credential, keys, claude));
  };

  // Without a link's tab, each row opens on its first one connected, so a
  // returning user lands on it.
  const [agent, setAgent] = useState<AgentId>(
    () => (place && isAgentId(place.tab) ? place.tab : (AGENT_IDS.find(agentConnected) ?? AGENT_IDS[0])),
  );
  const [gateway, setGateway] = useState<GatewayTab>(
    () =>
      (place && !isAgentId(place.tab) ? place.tab : null) ??
      GATEWAY_TABS.find((id) => keys[id].connected) ??
      GATEWAY_TABS[0],
  );

  function remember(tab: ProviderTab) {
    // A reload, or a link copied from the address bar, comes back here.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    url.searchParams.delete("method");
    window.history.replaceState(window.history.state, "", url);
  }

  function changeKeys(next: ProviderKeys, provider: keyof ProviderKeys) {
    // This card's own provider only: another card's reply, sent before a
    // change there landed, mustn't undo it here.
    setKeys((current) => ({ ...current, [provider]: next[provider] }));
    // The model menu offers what keys the user has: let it ask again.
    forgetOutrunnerModels();
  }

  return (
    <section className="space-y-10">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Providers (BYOK)</h1>
        <p className="text-sm text-muted-foreground">
          How your coding agents sign in, and your own API keys. Models on them are billed by each provider, not
          counted against your Outrunner plan.
        </p>
      </div>

      <div className="space-y-5">
        <h2 className="text-base font-medium text-foreground">Agents</h2>
        <SettingsTabs
          ids={AGENT_IDS}
          active={agent}
          onOpen={(next) => {
            setAgent(next);
            remember(next);
          }}
          label="Agents"
          idPrefix="agent"
          tabLabel={(id) => AGENTS[id].label}
          connected={agentConnected}
        />
        {/* Every panel stays mounted, so a key half typed or a save in flight
            survives a look at another tab. */}
        {AGENT_IDS.map((id) => (
          <div key={id} role="tabpanel" id={`agent-panel-${id}`} aria-labelledby={`agent-tab-${id}`} hidden={id !== agent}>
            <AgentAuthPanel
              agent={id}
              choices={choices}
              keys={keys}
              claude={claude}
              initialMethod={place?.tab === id ? place.method : undefined}
              onChoice={(agent, method) => setChoices((current) => ({ ...current, [agent]: method }))}
              onKeys={changeKeys}
              onClaude={setClaude}
            />
          </div>
        ))}
      </div>

      <div className="space-y-5">
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">Model providers</h2>
          <p className="text-sm text-muted-foreground">Other models for Claude Code, on your own key.</p>
        </div>
        <SettingsTabs
          ids={GATEWAY_TABS}
          active={gateway}
          onOpen={(next) => {
            setGateway(next);
            remember(next);
          }}
          label="Model providers"
          idPrefix="provider"
          tabLabel={(id) => PROVIDERS[id].label}
          connected={(id) => keys[id].connected}
        />
        {GATEWAY_TABS.map((id) => (
          <div key={id} role="tabpanel" id={`provider-panel-${id}`} aria-labelledby={`provider-tab-${id}`} hidden={id !== gateway}>
            <div className="space-y-6">
              <p className="text-sm text-muted-foreground">{PROVIDERS[id].description}</p>
              <ApiKeyCard provider={id} stored={keys[id]} onChange={(next) => changeKeys(next, id)} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
