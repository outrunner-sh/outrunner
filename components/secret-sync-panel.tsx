"use client";

import { KeyRound, Vault } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import type { EnvironmentSecretSync, IntegrationStatus, LinkView } from "@/lib/db/secret-sync";
import { requestJson } from "@/lib/http/request-json";
import { relativeTime } from "@/lib/nav/sidebar";
import {
  describeTarget,
  type DopplerLink,
  type InfisicalLink,
  PROVIDER_LABELS,
  SECRET_PROVIDERS,
  type SecretProvider,
  variableSources,
} from "@/lib/secret-sync/rules";
import { cn } from "@/lib/utils";

/**
 * A project's Doppler and Infisical links, under its Environment variables
 * (docs/secret-sync.md): what each reads, how its last sync went (and why
 * it failed, when it did: the sessions it was for started without its
 * secrets), and every variable a new session gets, by where it comes from.
 * Names only, never a value. Linking is an org admin's; a test sync,
 * anyone's who can change the project.
 */
export function SecretSyncPanel({
  environmentId,
  sync,
  ownNames,
  onChange,
}: {
  environmentId: string;
  sync: EnvironmentSecretSync;
  ownNames: string[];
  onChange: (sync: EnvironmentSecretSync) => void;
}) {
  const withNames = sync.links.filter((l) => l.lastSync && !l.lastSync.error && l.lastSync.names.length > 0);
  const sources = variableSources(
    ownNames,
    withNames.map((l) => ({ provider: l.provider, names: l.lastSync!.names })),
  );

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <SectionHeader title="Synced secrets" />
        <p className="text-xs text-muted-foreground">
          Fetched from the provider as each new session starts. The project&apos;s own variables win a name; Infisical&apos;s
          win over Doppler&apos;s.
        </p>
      </div>
      <div className="divide-y divide-border/60 rounded-lg border border-border/60">
        {SECRET_PROVIDERS.map((provider) => (
          <ProviderRow
            key={provider}
            provider={provider}
            environmentId={environmentId}
            sync={sync}
            integration={sync.integrations[provider]}
            link={sync.links.find((l) => l.provider === provider) ?? null}
            onChange={onChange}
          />
        ))}
      </div>
      {withNames.length > 0 && (
        <div className="space-y-2">
          <SectionHeader title="What a new session gets" />
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {sources.map((s) => (
              <li key={`${s.source}:${s.name}`} className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px]">
                <span className={cn("font-mono text-xs", s.shadowedBy ? "text-muted-foreground line-through" : "text-foreground")}>
                  {s.name}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {s.shadowedBy && <span>{s.shadowedBy === "project" ? "the project's value wins" : `${PROVIDER_LABELS[s.shadowedBy]}'s wins`}</span>}
                  <SourceTag source={s.source} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SourceTag({ source }: { source: "project" | SecretProvider }) {
  return (
    <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
      {source === "project" ? "Project" : PROVIDER_LABELS[source]}
    </span>
  );
}

function ago(iso: string): string {
  const age = relativeTime(iso);
  return age === "now" ? "just now" : `${age} ago`;
}

/** A link's last sync, as the row says it. */
function lastSyncText(link: LinkView): { tone: "ok" | "failed" | "none"; text: string } {
  const last = link.lastSync;
  if (!last) return { tone: "none", text: "Not synced yet: the next session, or Test sync, fetches them." };
  if (last.error) return { tone: "failed", text: `Last sync failed ${ago(last.at)}: ${last.error}` };
  const n = last.names.length;
  return { tone: "ok", text: `Synced ${n} secret${n === 1 ? "" : "s"} ${ago(last.at)}.` };
}

function ProviderRow({
  provider,
  environmentId,
  sync,
  integration,
  link,
  onChange,
}: {
  provider: SecretProvider;
  environmentId: string;
  sync: EnvironmentSecretSync;
  integration: IntegrationStatus | null;
  link: LinkView | null;
  onChange: (sync: EnvironmentSecretSync) => void;
}) {
  const label = PROVIDER_LABELS[provider];
  const Icon = provider === "doppler" ? KeyRound : Vault;
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<ActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const send = async (method: "PUT" | "DELETE" | "POST", body?: object) => {
    setState("pending");
    setError(null);
    try {
      const next = await requestJson<EnvironmentSecretSync>(
        `/api/environments/${environmentId}/secret-sync${method === "DELETE" ? `?provider=${provider}` : ""}`,
        { method, body, has: (d) => Array.isArray(d.links) },
      );
      onChange(next);
      setState("idle");
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
      setState("error");
    }
  };

  const status = link ? lastSyncText(link) : null;
  return (
    <div className="space-y-2 p-4 text-[13px]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium text-foreground">{label}</p>
            {!integration ? (
              <p className="text-xs text-muted-foreground">
                Not connected for this org.{" "}
                {sync.canLink ? (
                  <Link href={`/settings/org/integrations/${provider}`} className="underline underline-offset-4">
                    Connect {label}
                  </Link>
                ) : (
                  "An admin of the org can connect it."
                )}
              </p>
            ) : link ? (
              <p className="truncate font-mono text-xs text-muted-foreground">
                {describeTarget(provider, integration.settings, link.link)}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Not linked.{sync.canLink ? "" : " An admin of the org can link this project."}
              </p>
            )}
          </div>
        </div>
        {integration && !editing && (
          <span className="flex shrink-0 items-center gap-2">
            {link && sync.canTest && (
              <LoadingButton
                size="sm"
                variant="outline"
                status={state}
                labels={{ idle: "Test sync" }}
                onClick={() => void send("POST", { provider })}
              />
            )}
            {sync.canLink && (
              <Button size="sm" variant={link ? "ghost" : "outline"} onClick={() => setEditing(true)}>
                {link ? "Change" : "Link"}
              </Button>
            )}
            {link && sync.canLink && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void send("DELETE")}>
                Unlink
              </Button>
            )}
          </span>
        )}
      </div>
      {status && !editing && (
        <p
          className={cn(
            "text-xs",
            status.tone === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
          role={status.tone === "failed" ? "alert" : undefined}
        >
          {status.text}
          {status.tone === "failed" && " Sessions started without its secrets."}
        </p>
      )}
      {link?.lastSync && link.lastSync.skipped.length > 0 && !editing && (
        <p className="text-xs text-muted-foreground">
          Left out, as a session can&apos;t set them: <span className="font-mono">{link.lastSync.skipped.join(", ")}</span>
        </p>
      )}
      {provider === "infisical" && link && !editing && (
        <p className="text-xs text-muted-foreground">
          Sessions also get the <span className="font-mono">infisical</span> CLI, signed in as the machine identity:{" "}
          <span className="font-mono">infisical secrets</span>, <span className="font-mono">infisical run -- …</span>.
        </p>
      )}
      {editing && integration && (
        <LinkForm
          provider={provider}
          integration={integration}
          link={link}
          state={state}
          onCancel={() => {
            setEditing(false);
            setError(null);
          }}
          onSave={(body) => void send("PUT", { provider, ...body })}
        />
      )}
      {error && <InlineMessage>{error}</InlineMessage>}
    </div>
  );
}

/** Where the project reads from: blank fields are the connection's own. */
function LinkForm({
  provider,
  integration,
  link,
  state,
  onCancel,
  onSave,
}: {
  provider: SecretProvider;
  integration: IntegrationStatus;
  link: LinkView | null;
  state: ActionStatus;
  onCancel: () => void;
  onSave: (body: Record<string, string>) => void;
}) {
  const doppler = provider === "doppler" ? ((link?.link as DopplerLink | undefined) ?? null) : null;
  const infisical = provider === "infisical" ? ((link?.link as InfisicalLink | undefined) ?? null) : null;
  const [a, setA] = useState(doppler?.project ?? infisical?.projectId ?? "");
  const [b, setB] = useState(doppler?.config ?? infisical?.environment ?? "");
  const [path, setPath] = useState(infisical?.path ?? "");
  const service = integration.provider === "doppler" && integration.settings.tokenKind === "service";
  const defaults =
    integration.provider === "doppler"
      ? { a: integration.settings.project, b: integration.settings.config }
      : { a: integration.settings.projectId, b: integration.settings.environment };

  return (
    <form
      className="space-y-3 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(provider === "doppler" ? { project: a, config: b } : { projectId: a, environment: b, path });
      }}
    >
      {service ? (
        <p className="text-xs text-muted-foreground">
          The org&apos;s Doppler service token reads its own config, {integration.label}: the project gets its secrets.
        </p>
      ) : (
        <div className={cn("grid gap-3", provider === "infisical" ? "grid-cols-3" : "grid-cols-2")}>
          <LinkField
            label={provider === "doppler" ? "Project" : "Project ID"}
            value={a}
            onChange={setA}
            placeholder={defaults.a ?? undefined}
          />
          <LinkField label={provider === "doppler" ? "Config" : "Environment"} value={b} onChange={setB} placeholder={defaults.b ?? undefined} />
          {provider === "infisical" && <LinkField label="Secret path" value={path} onChange={setPath} placeholder="/" />}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <LoadingButton type="submit" status={state} labels={{ idle: link ? "Save" : "Link" }} />
      </div>
    </form>
  );
}

function LinkField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="font-mono text-xs"
      />
    </label>
  );
}

/** The links whose last sync failed, for a notice at the top of the
 *  project's page whatever section is open. */
export function failedLinks(sync: EnvironmentSecretSync | null): LinkView[] {
  return sync?.links.filter((l) => l.lastSync?.error) ?? [];
}
