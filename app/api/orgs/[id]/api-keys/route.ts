import { NextResponse } from "next/server";

import { madeKey, newKeyRequest } from "@/lib/api/key-routes";
import { recordAudit } from "@/lib/audit/record";
import { createApiKey, listOrgApiKeys, revokeApiKey } from "@/lib/db/api-keys";
import { savingSettings } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import { orgCaller } from "@/lib/orgs/routes";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The org's API keys (Settings → Org → API keys; lib/db/api-keys.ts), its
 * admins' alone: each acts as the admin who made it, in this org, with their
 * Roles & access (lib/api/auth.ts). GET lists them (never the keys
 * themselves); POST makes one, answering with it the only time it's shown;
 * DELETE (?id=) revokes one, whichever admin made it. Both are in the org's
 * audit log.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  return NextResponse.json({ keys: await listOrgApiKeys(id) });
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const asked = await newKeyRequest(request);
  if (asked instanceof Response) return asked;
  return savingSettings("org API keys", async () => {
    const { key, id: keyId, hint } = await createApiKey({ userId: caller.owner.id, orgId: id, ...asked });
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "api_key.created",
      resource: { type: "api_key", id: keyId, label: asked.name },
      // Its last 4, as the page shows it: never the key.
      details: { hint, expiresAt: asked.expiresAt },
    });
    return madeKey(key, await listOrgApiKeys(id));
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const keyId = new URL(request.url).searchParams.get("id") ?? "";
  if (!isUuid(keyId)) return NextResponse.json({ error: "No such key still working." }, { status: 404 });
  return savingSettings("org API keys", async () => {
    const revoked = await revokeApiKey(keyId, caller.owner.id, { orgId: id });
    if (!revoked) return NextResponse.json({ error: "No such key still working." }, { status: 404 });
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "api_key.revoked",
      resource: { type: "api_key", id: keyId, label: revoked.name },
      details: { hint: revoked.hint },
    });
    return NextResponse.json({ keys: await listOrgApiKeys(id) });
  });
}
