"use client";

import { PageHeader } from "@/components/page-layout";
import Link from "next/link";
import { useState } from "react";
import { ApiKeyCard, type ProviderKeys } from "@/components/api-key-card";
import { AgentIcon, ProviderIcon } from "@/components/brand-icons";
import { ClaudeConnection } from "@/components/claude-connection";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";
import { CodexConnection } from "@/components/codex-connection";
import { AuthMethodCards } from "@/components/auth-method-cards";
import { ConnectionStatus } from "@/components/settings-details";
import { SettingsTabs } from "@/components/settings-tabs";
import { AGENTS, agentOfKey, isAgentId } from "@/lib/agents/registry";
import { replaceAddressBar } from "@/lib/client/address-bar";
import type { Org } from "@/lib/orgs/active";
import { KEY_PROVIDER_IDS, PROVIDERS } from "@/lib/providers/registry";
import {
  PROVIDER_TABS,
  PROVIDERS_SETTINGS_HREF,
  type ProviderPlace,
  type ProviderTab,
  withProviderTab,
  withProviderMethod,
} from "@/lib/settings-links";

export function OrgKeysSettings({
  org,
  initial,
  place,
  initialClaude = { connected: false, last4: null, updatedAt: null },
}: {
  initialClaude?: ClaudeTokenMeta;
  org: Org;
  initial: ProviderKeys;
  place?: ProviderPlace;
}) {
  const [keys, setKeys] = useState(initial);
  const [active, setActive] = useState<ProviderTab>(place?.tab ?? "claude");
  const [claude, setClaude] = useState(initialClaude);
  const [claudeMethod, setClaudeMethod] = useState<"subscription" | "api-key">(
    place?.tab === "claude" && place.method === "api-key"
      ? "api-key"
      : "subscription",
  );
  const admin = org.role === "admin";
  const [codexConnected, setCodexConnected] = useState(false);
  const [codexMethod, setCodexMethod] = useState<"codex-account" | "api-key">(
    place?.tab === "codex" && place.method === "api-key"
      ? "api-key"
      : "codex-account",
  );
  const codexMethods = AGENTS.codex.methods.filter(
    (method) => method.id === "codex-account" || method.id === "api-key",
  );
  const providerFor = (tab: ProviderTab) =>
    KEY_PROVIDER_IDS.find((id) => agentOfKey(id) === tab || id === tab)!;
  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <PageHeader title="Coding agents" />
        <p className="text-[13px] text-muted-foreground">
          Organization · {org.name}. Shared provider accounts for members’ cloud
          sessions. Admins manage these credentials.
        </p>
        <p className="text-xs text-muted-foreground">
          Your{" "}
          <Link
            href={PROVIDERS_SETTINGS_HREF}
            className="underline underline-offset-2"
          >
            private personal credentials
          </Link>{" "}
          are used first. If a subscription reaches its usage limit, cloud
          sessions automatically try the organization’s subscription for the
          same agent. Sessions on a Mac use your own credentials.
        </p>
        <p className="text-xs text-muted-foreground">
          A session’s agent can read the key it runs on. Share keys only with
          members you trust.
        </p>
      </div>
      <div className="space-y-5">
        <SettingsTabs
          ids={PROVIDER_TABS}
          active={active}
          onOpen={(tab) => {
            setActive(tab);
            replaceAddressBar(
              withProviderTab(new URL(window.location.href), tab),
            );
          }}
          label="Agents and model providers"
          idPrefix="org-provider"
          tabLabel={(id) => (
            <>
              {isAgentId(id) ? (
                <AgentIcon agent={id} />
              ) : (
                <ProviderIcon provider={id} />
              )}
              {isAgentId(id) ? AGENTS[id].label : PROVIDERS[id].label}
            </>
          )}
          connected={(id) =>
            (id === "codex" && codexConnected) ||
            (id === "claude" && claude.connected) ||
            keys[providerFor(id)].connected
          }
        />
        {PROVIDER_TABS.map((tab) => {
          const provider = providerFor(tab);
          return (
            <div
              key={tab}
              role="tabpanel"
              id={`org-provider-panel-${tab}`}
              aria-labelledby={`org-provider-tab-${tab}`}
              hidden={active !== tab}
              className="space-y-5"
            >
              {tab === "codex" && (
                <div className="space-y-3">
                  <h2 className="text-sm font-medium">Authentication</h2>
                  <AuthMethodCards
                    methods={codexMethods}
                    chosen={null}
                    shown={codexMethod}
                    busy={false}
                    label="Organization Codex authentication"
                    onChoose={(method) => {
                      if (method !== "codex-account" && method !== "api-key")
                        return;
                      setCodexMethod(method);
                      replaceAddressBar(
                        withProviderMethod(
                          new URL(window.location.href),
                          "codex",
                          method,
                        ),
                      );
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Both connections are shared organization credentials.
                    Personal credentials and saved authentication choices keep
                    their existing priority.
                  </p>
                </div>
              )}
              {tab === "codex" && (
                <div hidden={codexMethod !== "codex-account"}>
                  <CodexConnection
                    orgId={org.id}
                    active={
                      active === "codex" && codexMethod === "codex-account"
                    }
                    onConnected={setCodexConnected}
                  />
                </div>
              )}
              {tab === "claude" && (
                <>
                  <div className="space-y-3">
                    <h2 className="text-sm font-medium">Authentication</h2>
                    <AuthMethodCards
                      methods={AGENTS.claude.methods.filter(
                        (method) =>
                          method.id === "subscription" ||
                          method.id === "api-key",
                      )}
                      chosen={null}
                      shown={claudeMethod}
                      busy={false}
                      label="Organization Claude authentication"
                      onChoose={(method) => {
                        if (method !== "subscription" && method !== "api-key")
                          return;
                        setClaudeMethod(method);
                        replaceAddressBar(
                          withProviderMethod(
                            new URL(window.location.href),
                            "claude",
                            method,
                          ),
                        );
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Shared with members’ cloud sessions. Subscription fallback
                      stays within the same coding agent.
                    </p>
                  </div>
                  <div hidden={claudeMethod !== "subscription"}>
                    {admin ? (
                      <ClaudeConnection
                        orgId={org.id}
                        meta={claude}
                        onChange={setClaude}
                        active={
                          active === "claude" && claudeMethod === "subscription"
                        }
                      />
                    ) : (
                      <>
                        <ConnectionStatus connected={claude.connected} />
                        <p className="text-xs text-muted-foreground">
                          Only organization admins can change shared
                          credentials.
                        </p>
                      </>
                    )}
                  </div>
                </>
              )}
              <div
                hidden={
                  (tab === "codex" && codexMethod !== "api-key") ||
                  (tab === "claude" && claudeMethod !== "api-key")
                }
              >
                {admin ? (
                  <ApiKeyCard
                    provider={provider}
                    stored={keys[provider]}
                    onChange={(next) =>
                      setKeys((current) => ({
                        ...current,
                        [provider]: next[provider],
                      }))
                    }
                    endpoint={`/api/orgs/${org.id}/keys`}
                    whose="The org's"
                  />
                ) : (
                  <>
                    <ConnectionStatus connected={keys[provider].connected} />
                    <p className="text-xs text-muted-foreground">
                      Only organization admins can change shared credentials.
                    </p>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
