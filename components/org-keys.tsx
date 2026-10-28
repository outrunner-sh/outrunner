"use client";

import Link from "next/link";
import { useState } from "react";

import { ApiKeyCard, type ProviderKeys } from "@/components/api-key-card";
import { ConnectionStatus } from "@/components/settings-details";
import type { Org } from "@/lib/orgs/active";
import { KEY_PROVIDER_IDS, PROVIDERS } from "@/lib/providers/registry";
import { PROVIDERS_SETTINGS_HREF } from "@/lib/settings-links";

/**
 * Settings → Org → Keys: a key for each model provider, which the org's
 * members' cloud sessions run on where they have none of their own. Its
 * admins save, replace and remove them; members see which providers have one.
 */
export function OrgKeysSettings({ org, initial }: { org: Org; initial: ProviderKeys }) {
  const [keys, setKeys] = useState(initial);
  const admin = org.role === "admin";
  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Keys</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {`Keys ${org.name}'s members' cloud sessions run on, billed to the org's accounts. A member's own key under `}
          <Link href={PROVIDERS_SETTINGS_HREF} className="text-foreground underline underline-offset-2">
            Settings → Providers
          </Link>
          {" always wins. Sessions on a Mac use only the member's own."}
        </p>
        <p className="max-w-prose text-xs text-muted-foreground">
          A session&apos;s agent can read the key it runs on, so share a key only with members you trust with it.
        </p>
      </div>
      {KEY_PROVIDER_IDS.map((provider) => (
        <div key={provider} className="space-y-3 border-t border-border/60 pt-6">
          <h2 className="text-sm font-medium text-foreground">{providerTitle(provider)}</h2>
          {admin ? (
            <ApiKeyCard
              provider={provider}
              stored={keys[provider]}
              onChange={setKeys}
              endpoint={`/api/orgs/${org.id}/keys`}
              whose="The org's"
            />
          ) : (
            <div className="flex items-center justify-between gap-4">
              <ConnectionStatus connected={keys[provider].connected} />
              {keys[provider].connected && keys[provider].hint ? (
                <span className="font-mono text-xs text-muted-foreground">········{keys[provider].hint}</span>
              ) : null}
            </div>
          )}
        </div>
      ))}
      {!admin && <p className="text-xs text-muted-foreground">Only the org&apos;s admins change its keys.</p>}
    </section>
  );
}

/** A provider as this page names it: the agents' keys by their agent. */
function providerTitle(provider: (typeof KEY_PROVIDER_IDS)[number]): string {
  if (provider === "anthropic") return "Anthropic (Claude Code)";
  if (provider === "openai") return "OpenAI (Codex)";
  return PROVIDERS[provider].label;
}
