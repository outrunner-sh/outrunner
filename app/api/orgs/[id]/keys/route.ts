import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getOrg } from "@/lib/db/orgs";
import { clearOrgProviderKey, getOrgKeyStatuses, setOrgProviderKey } from "@/lib/db/org-credentials";
import { savingSettings } from "@/lib/http/settings-save";
import { orgCaller } from "@/lib/orgs/routes";
import { acceptedKey } from "@/lib/providers/accept-key";
import { isKeyProviderId, PROVIDERS } from "@/lib/providers/registry";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A team org's keys for model providers (Settings → Org → Keys;
 * lib/db/org-credentials.ts), which its members' cloud sessions run on where
 * they have no key of their own. GET, for any member, says which providers
 * have one (their last 4 characters, never the key). PUT, an admin's, stores
 * a key its provider has accepted; DELETE forgets one.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  return NextResponse.json({ keys: await getOrgKeyStatuses(id) });
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const refused = await personalRefusal(id);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { provider?: unknown; key?: unknown } | null;
  const provider = body?.provider;
  if (!isKeyProviderId(provider)) {
    return NextResponse.json({ error: "Choose one of the providers." }, { status: 400 });
  }
  const accepted = await acceptedKey(provider, body?.key);
  if (accepted instanceof Response) return accepted;
  return savingSettings("org keys", async () => {
    await setOrgProviderKey(id, provider, accepted.key, caller.owner.id);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "key.saved",
      resource: { type: "key", id: provider, label: PROVIDERS[provider].label },
      // Its last 4, as the page shows it: never the key.
      details: { hint: accepted.key.slice(-4) },
    });
    return NextResponse.json({ keys: await getOrgKeyStatuses(id), warning: accepted.warning });
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const provider = new URL(request.url).searchParams.get("provider");
  if (!isKeyProviderId(provider)) {
    return NextResponse.json({ error: "Choose one of the providers." }, { status: 400 });
  }
  return savingSettings("org keys", async () => {
    await clearOrgProviderKey(id, provider);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "key.removed",
      resource: { type: "key", id: provider, label: PROVIDERS[provider].label },
    });
    return NextResponse.json({ keys: await getOrgKeyStatuses(id) });
  });
}

/** A personal org's keys are its owner's own, under Settings → Providers. */
async function personalRefusal(orgId: string): Promise<Response | null> {
  const org = await getOrg(orgId);
  if (!org?.personal) return null;
  return NextResponse.json(
    { error: "Your personal org runs on your own keys: save them under Settings → Providers." },
    { status: 409 },
  );
}
