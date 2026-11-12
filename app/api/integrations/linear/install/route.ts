import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { appUrl } from "@/lib/orgs/notify";
import { getOrgContext } from "@/lib/orgs/server";
import { LINEAR_COOKIE_PATH, LINEAR_NONCE_COOKIE, linearAuthorizeUrl, linearConfig, signLinearState } from "@/lib/trackers/linear";

/**
 * Install the Linear app for the org the app is showing: off to Linear, where one
 * of the workspace's admins authorizes it, carrying a signed state that names the
 * org and its admin, which app/api/integrations/linear/callback checks on the way
 * back. The org's admins only.
 */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const back = (code: string) => NextResponse.redirect(appUrl(`/settings/org/linear?linear=${code}`, origin), { status: 303 });
  const owner = await getOwner();
  if (!owner) return NextResponse.redirect(appUrl("/signin?next=/settings/org/linear", origin), { status: 303 });
  const config = linearConfig();
  if (!config) return back("unavailable");
  const context = await getOrgContext().catch(() => null);
  if (!context || context.active.role !== "admin") return back("not_admin");

  const nonce = randomUUID();
  const jar = await cookies();
  jar.set(LINEAR_NONCE_COOKIE, nonce, { path: LINEAR_COOKIE_PATH, httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });
  const state = signLinearState({ kind: "install", ownerId: owner.id, orgId: context.active.id, nonce }, config.clientSecret);
  return NextResponse.redirect(linearAuthorizeUrl(config, "install", state), { status: 303 });
}
