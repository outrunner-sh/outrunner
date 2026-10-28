/**
 * Making and revoking API keys from Settings (app/api/orgs/[id]/api-keys,
 * app/api/settings/api-keys): what a new key's request says, and the answer,
 * the one time the key itself is ever shown.
 */

import { NextResponse } from "next/server";

import { keyExpiry, keyName, MAX_KEY_DAYS } from "@/lib/api/keys";
import type { ApiKeyRecord } from "@/lib/db/api-keys";

export type NewKeyRequest = { name: string; expiresAt: string | null };

/** A new key's name and expiry as posted, or the answer refusing them. */
export async function newKeyRequest(request: Request): Promise<NewKeyRequest | Response> {
  const body = (await request.json().catch(() => null)) as { name?: unknown; expiresInDays?: unknown } | null;
  const name = keyName(body?.name);
  if (!name) return NextResponse.json({ error: "Give the key a name, up to 80 characters." }, { status: 400 });
  const expiresAt = keyExpiry(body?.expiresInDays);
  if (expiresAt === undefined) {
    return NextResponse.json({ error: `A key lasts 1 to ${MAX_KEY_DAYS} days, or never expires.` }, { status: 400 });
  }
  return { name, expiresAt };
}

/** The made key, shown once, with the list it's now in. */
export function madeKey(key: string, keys: ApiKeyRecord[]): NextResponse {
  return NextResponse.json({ key, keys }, { status: 201 });
}
