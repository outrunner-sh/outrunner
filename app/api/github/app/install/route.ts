import { cookies } from "next/headers";
import { connection, NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { memberRole } from "@/lib/db/orgs";
import { requireEnv } from "@/lib/env";
import { githubAppConfig, installNonce, installUrl } from "@/lib/github/app";
import {
  CODE_REVIEW_PATH,
  INSTALL_COOKIE,
  INSTALL_COOKIE_PATH,
  INSTALL_COOKIE_SECONDS,
  installCookieValue,
} from "@/lib/github/app-setup";
import { isUuid } from "@/lib/ids";

/**
 * Settings → Code review's Install on GitHub: `?org=<id>`, by one of that
 * org's admins. Keeps the org and a nonce in a cookie and sends the admin to
 * GitHub's install page with the nonce as `state`; GitHub sends them back to
 * the setup route (lib/github/app-setup.ts), which links the installation.
 *
 * A GET, as it's a link: at worst a crafted one shows a signed-in admin
 * GitHub's install page, which installs nothing until they confirm there.
 */
export async function GET(request: Request) {
  await connection();
  const base = requireEnv("RUNTIME_BASE_URL");
  const back = (query: string) => NextResponse.redirect(new URL(`${CODE_REVIEW_PATH}?${query}`, base), 303);

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.redirect(new URL(`/signin?next=${encodeURIComponent(CODE_REVIEW_PATH)}`, base), 303);
  }
  const config = githubAppConfig();
  if (!config) return back("problem=not_configured");

  const orgId = new URL(request.url).searchParams.get("org") ?? "";
  if (!isUuid(orgId) || (await memberRole(orgId, owner.id)) !== "admin") return back("problem=not_admin");

  const nonce = installNonce();
  (await cookies()).set(INSTALL_COOKIE, installCookieValue(orgId, nonce), {
    path: INSTALL_COOKIE_PATH,
    httpOnly: true,
    // Lax: sent on GitHub's top-level redirect back to the setup URL.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: INSTALL_COOKIE_SECONDS,
  });
  return NextResponse.redirect(installUrl(config.slug, nonce), 303);
}
