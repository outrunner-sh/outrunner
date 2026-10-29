"use client";
import Link from "next/link";
import { useState } from "react";
import { ApiKeyCard, type ProviderKeys } from "@/components/api-key-card";
import { AgentIcon, ProviderIcon } from "@/components/brand-icons";
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
} from "@/lib/settings-links";

export function OrgKeysSettings({
  org,
  initial,
  place,
}: {
  org: Org;
  initial: ProviderKeys;
  place?: ProviderPlace;
}) {
  const [keys, setKeys] = useState(initial);
  const [active, setActive] = useState<ProviderTab>(place?.tab ?? "claude");
  const admin = org.role === "admin";
  const providerFor = (tab: ProviderTab) =>
    KEY_PROVIDER_IDS.find((id) => agentOfKey(id) === tab || id === tab)!;
  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Coding agents</h1>
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
          keep their existing priority. Sessions on a Mac use your own
          credentials.
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
          connected={(id) => keys[providerFor(id)].connected}
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
              {isAgentId(tab) && (
                <p className="text-[13px] text-muted-foreground">
                  Shared subscription connections for {AGENTS[tab].label} are
                  not available on this release. You can use a shared{" "}
                  {PROVIDERS[provider].label} API key here, or connect your
                  subscription in Personal → Coding agents.
                </p>
              )}
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
          );
        })}
      </div>
    </section>
  );
}
