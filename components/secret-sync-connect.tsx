"use client";

import Link from "next/link";
import { useState } from "react";

import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Input } from "@/components/ui/input";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import type { IntegrationStatus, OrgSecretIntegrations } from "@/lib/db/secret-sync";
import { requestJson } from "@/lib/http/request-json";
import { INFISICAL_CLOUD, PROVIDER_LABELS, type SecretProvider } from "@/lib/secret-sync/rules";

/**
 * The org's connection to Doppler or Infisical: what it reaches and, for an
 * admin, the form that connects it, checked with the provider as it's
 * saved. Credentials are write-only: the form never shows the kept ones, and
 * left blank on a reconnect, they're kept as they are.
 */
export function SecretSyncConnect({
  orgId,
  provider,
  admin,
  initial,
}: {
  orgId: string;
  provider: SecretProvider;
  admin: boolean;
  initial: IntegrationStatus | null;
}) {
  const [status, setStatus] = useState(initial);
  const label = PROVIDER_LABELS[provider];
  const [removing, setRemoving] = useState<ActionStatus>("idle");
  const [removeError, setRemoveError] = useState<string | null>(null);

  const disconnect = async () => {
    setRemoving("pending");
    setRemoveError(null);
    try {
      const answer = await requestJson<{ integrations: OrgSecretIntegrations }>(`/api/orgs/${orgId}/secret-sync?provider=${provider}`, {
        method: "DELETE",
        has: (d) => d.integrations !== undefined,
      });
      setStatus(answer.integrations[provider]);
      setRemoving("idle");
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : "Couldn't disconnect.");
      setRemoving("error");
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Connection</h2>
        {status ? (
          <div className="space-y-2 rounded-md border border-border/60 px-3 py-2.5 text-sm">
            <p className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-emerald-500" aria-label="Connected" />
              <span className="text-foreground">{status.label}</span>
            </p>
            <p className="text-xs text-muted-foreground">{summary(status)}</p>
            <p className="text-xs text-muted-foreground">
              {status.links === 0
                ? "No project is linked yet. Link one under its Environment variables."
                : `Linked to ${status.links} project${status.links === 1 ? "" : "s"}.`}
            </p>
            {admin && (
              <div className="flex items-center gap-3 pt-1">
                {removing === "pending" ? (
                  <span className="text-xs text-muted-foreground">Disconnecting…</span>
                ) : (
                  <HoldToConfirm label="Disconnect" onConfirm={() => void disconnect()} className="h-7 px-2.5 text-xs" />
                )}
                <span className="text-xs text-muted-foreground">
                  Unlinks every project: their new sessions start without {label}&apos;s secrets.
                </span>
              </div>
            )}
            {removeError && <InlineMessage>{removeError}</InlineMessage>}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Not connected.{admin ? "" : ` Ask an admin of the org to connect ${label}.`}
          </p>
        )}
      </div>

      {admin && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">{status ? "Reconnect" : "Connect"}</h2>
          {provider === "doppler" ? (
            <DopplerForm orgId={orgId} status={status} onSaved={setStatus} />
          ) : (
            <InfisicalForm orgId={orgId} status={status} onSaved={setStatus} />
          )}
          <p className="text-xs text-muted-foreground">
            Credentials are encrypted and stay on Outrunner&apos;s servers. See{" "}
            <Link href="/settings/org/audit" className="underline underline-offset-4">
              the audit log
            </Link>{" "}
            for who changed them.
          </p>
        </div>
      )}
    </div>
  );
}

function summary(status: IntegrationStatus): string {
  if (status.provider === "doppler") {
    const s = status.settings;
    if (s.tokenKind === "service") return "A service token: every linked project reads its config.";
    return `A personal or service account token. Linked projects read ${s.project ?? "?"} / ${s.config ?? "?"} unless they name another.`;
  }
  const s = status.settings;
  const defaults = s.projectId && s.environment ? ` Linked projects read ${s.projectId} · ${s.environment} unless they name another.` : "";
  return `A machine identity on ${s.siteUrl}.${defaults}`;
}

type FormProps = { orgId: string; status: IntegrationStatus | null; onSaved: (s: IntegrationStatus | null) => void };

/** Save the connection; its state for the button, and why it failed. */
function useConnect(orgId: string, provider: SecretProvider, onSaved: FormProps["onSaved"]) {
  const [state, setState] = useState<ActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const save = async (body: Record<string, string>) => {
    setState("pending");
    setError(null);
    try {
      const answer = await requestJson<{ integrations: OrgSecretIntegrations }>(`/api/orgs/${orgId}/secret-sync`, {
        method: "PUT",
        body: { provider, ...body },
        has: (d) => d.integrations !== undefined,
      });
      onSaved(answer.integrations[provider]);
      setState("success");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect.");
      setState("error");
      return false;
    }
  };
  return { state, error, save };
}

function Field({
  label,
  hint,
  ...props
}: React.ComponentProps<typeof Input> & { label: string; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <Input autoComplete="off" spellCheck={false} className="font-mono text-xs" {...props} />
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function DopplerForm({ orgId, status, onSaved }: FormProps) {
  const current = status?.provider === "doppler" ? status.settings : null;
  const [token, setToken] = useState("");
  const [project, setProject] = useState(current?.tokenKind === "account" ? (current.project ?? "") : "");
  const [config, setConfig] = useState(current?.tokenKind === "account" ? (current.config ?? "") : "");
  const connect = useConnect(orgId, "doppler", onSaved);
  const service = token ? token.startsWith("dp.st.") : current?.tokenKind !== "account";

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await connect.save({ token, project, config })) setToken("");
      }}
    >
      <Field
        label="Token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={status ? "Leave blank to keep the current token" : "dp.st.… or dp.pt.…"}
        hint="A service token (Doppler → project → config → Access) reads that config. A personal or service account token reads the project and config below."
      />
      {!service && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Project" value={project} onChange={(e) => setProject(e.target.value)} placeholder="backend" />
          <Field label="Config" value={config} onChange={(e) => setConfig(e.target.value)} placeholder="dev" />
        </div>
      )}
      <div className="flex items-center justify-end gap-3">
        {connect.error && <InlineMessage>{connect.error}</InlineMessage>}
        <LoadingButton
          type="submit"
          status={connect.state}
          disabled={!status && !token.trim()}
          labels={{ idle: status ? "Save" : "Save & connect", pending: "Checking with Doppler", success: "Connected" }}
        />
      </div>
    </form>
  );
}

function InfisicalForm({ orgId, status, onSaved }: FormProps) {
  const current = status?.provider === "infisical" ? status.settings : null;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [siteUrl, setSiteUrl] = useState(current && current.siteUrl !== INFISICAL_CLOUD ? current.siteUrl : "");
  const [projectId, setProjectId] = useState(current?.projectId ?? "");
  const [environment, setEnvironment] = useState(current?.environment ?? "");
  const connect = useConnect(orgId, "infisical", onSaved);
  const keep = status ? "Leave blank to keep the current one" : undefined;

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await connect.save({ clientId, clientSecret, siteUrl, projectId, environment })) {
          setClientId("");
          setClientSecret("");
        }
      }}
    >
      <p className="text-xs text-muted-foreground">
        A machine identity with Universal Auth, added to the project with read access to the environments to sync.
      </p>
      <InlineMessage tone="warning">
        Use an identity scoped to only what sessions should read. A project linked with the CLI turned on gives its
        sessions an access token that reads everything this identity can, in every project and environment.
      </InlineMessage>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={keep} />
        <Field
          label="Client secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={keep}
        />
      </div>
      <Field
        label="Site URL"
        value={siteUrl}
        onChange={(e) => setSiteUrl(e.target.value)}
        placeholder={INFISICAL_CLOUD}
        hint="Only for EU Cloud (https://eu.infisical.com) or a self-hosted Infisical reachable from the internet."
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Project ID"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="From the project's settings"
        />
        <Field
          label="Environment"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
          placeholder="dev"
          hint="The default for linked projects; each can name its own."
        />
      </div>
      <div className="flex items-center justify-end gap-3">
        {connect.error && <InlineMessage>{connect.error}</InlineMessage>}
        <LoadingButton
          type="submit"
          status={connect.state}
          disabled={!status && !(clientId.trim() && clientSecret.trim())}
          labels={{ idle: status ? "Save" : "Save & connect", pending: "Checking with Infisical", success: "Connected" }}
        />
      </div>
    </form>
  );
}
