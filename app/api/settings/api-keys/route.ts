import { NextResponse } from "next/server";

import { madeKey, newKeyRequest } from "@/lib/api/key-routes";
import { getOwner } from "@/lib/auth/owner";
import { createApiKey, listPersonalApiKeys, revokeApiKey } from "@/lib/db/api-keys";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";

/**
 * The signed-in user's personal API keys (Settings → API keys): each acts as
 * them, in any org they're a member of (`?org=` picks it, else their
 * personal one), with their Roles & access there (lib/api/auth.ts). POST
 * answers with the key the only time it's shown; DELETE (?id=) revokes one.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return NextResponse.json({ keys: await listPersonalApiKeys(owner.id) });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const asked = await newKeyRequest(request);
  if (asked instanceof Response) return asked;
  return savingSettings("API keys", async () => {
    const { key } = await createApiKey({ userId: owner.id, orgId: null, ...asked });
    return madeKey(key, await listPersonalApiKeys(owner.id));
  });
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const keyId = new URL(request.url).searchParams.get("id") ?? "";
  if (!isUuid(keyId)) return NextResponse.json({ error: "No such key still working." }, { status: 404 });
  return savingSettings("API keys", async () => {
    if (!(await revokeApiKey(keyId, owner.id, { userId: owner.id }))) {
      return NextResponse.json({ error: "No such key still working." }, { status: 404 });
    }
    return NextResponse.json({ keys: await listPersonalApiKeys(owner.id) });
  });
}
