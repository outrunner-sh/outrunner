import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import {
  orgSecretIntegrations,
  removeOrgSecretIntegration,
  saveOrgSecretIntegration,
  storedCredentials,
} from "@/lib/db/secret-sync";
import { savingSettings } from "@/lib/http/settings-save";
import { orgCaller } from "@/lib/orgs/routes";
import { acceptDoppler, acceptInfisical, type Connection } from "@/lib/secret-sync/connect";
import { SyncError } from "@/lib/secret-sync/providers";
import { isSecretProvider, PROVIDER_LABELS, SecretSyncRuleError } from "@/lib/secret-sync/rules";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The org's Doppler and Infisical connections (Settings → Org →
 * Integrations; docs/secret-sync.md). GET, for any member, says what each is
 * connected to, never its credentials. PUT, an admin's, keeps a connection
 * its provider has accepted, the credentials sealed; credentials left out
 * are the ones already kept, for a change of project or config. DELETE
 * forgets one, and unlinks the projects linked to it.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  return NextResponse.json({ integrations: await orgSecretIntegrations(id) });
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const provider = body?.provider;
  if (!body || !isSecretProvider(provider)) {
    return NextResponse.json({ error: "Choose Doppler or Infisical." }, { status: 400 });
  }

  let connection: Connection;
  try {
    if (provider === "doppler") {
      connection = await acceptDoppler(body, await storedCredentials(id, "doppler"));
    } else {
      const [credentials, current] = await Promise.all([storedCredentials(id, "infisical"), orgSecretIntegrations(id)]);
      const siteUrl = current.infisical?.provider === "infisical" ? current.infisical.settings.siteUrl : null;
      connection = await acceptInfisical(body, credentials && siteUrl ? { credentials, siteUrl } : null);
    }
  } catch (error) {
    if (error instanceof SecretSyncRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
    // The provider's refusal is the user's to fix; its silence, a retry.
    if (error instanceof SyncError) return NextResponse.json({ error: error.message }, { status: error.refused ? 400 : 502 });
    throw error;
  }

  return savingSettings(`the org's ${provider} connection`, async () => {
    await saveOrgSecretIntegration(id, connection, caller.owner.id);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "secret_sync.connected",
      resource: { type: "integration", id: provider, label: PROVIDER_LABELS[provider] },
      // What it reaches, as the page shows it: never a credential.
      details: { label: connection.label },
    });
    return NextResponse.json({ integrations: await orgSecretIntegrations(id) });
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const provider = new URL(request.url).searchParams.get("provider");
  if (!isSecretProvider(provider)) {
    return NextResponse.json({ error: "Choose Doppler or Infisical." }, { status: 400 });
  }
  return savingSettings(`the org's ${provider} connection`, async () => {
    const links = await removeOrgSecretIntegration(id, provider);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "secret_sync.disconnected",
      resource: { type: "integration", id: provider, label: PROVIDER_LABELS[provider] },
      details: { links },
    });
    return NextResponse.json({ integrations: await orgSecretIntegrations(id) });
  });
}
