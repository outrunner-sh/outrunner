import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { appUrl } from "@/lib/orgs/notify";
import { LINEAR_COOKIE_PATH, LINEAR_NONCE_COOKIE, linearAuthorizeUrl, linearConfig, signLinearState } from "@/lib/trackers/linear";

/**
 * Link the signed-in user's Linear account: off to sign in to Linear as themselves.
 * A link is only ever made from that sign-in (app/api/integrations/linear/callback),
 * never from a typed ID or a matching email.
 */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const owner = await getOwner();
  if (!owner) return NextResponse.redirect(appUrl("/signin?next=/settings/integrations", origin), { status: 303 });
  const config = linearConfig();
  if (!config) return NextResponse.redirect(appUrl("/settings/integrations?linear=unavailable", origin), { status: 303 });

  const nonce = randomUUID();
  const jar = await cookies();
  jar.set(LINEAR_NONCE_COOKIE, nonce, { path: LINEAR_COOKIE_PATH, httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });
  const state = signLinearState({ kind: "link", ownerId: owner.id, orgId: null, nonce }, config.clientSecret);
  return NextResponse.redirect(linearAuthorizeUrl(config, "link", state), { status: 303 });
}
