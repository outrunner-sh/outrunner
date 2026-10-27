import { cookies } from "next/headers";
import { connection, NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getGithubToken } from "@/lib/db/credentials";
import { linkInstallation } from "@/lib/db/github-installations";
import { memberRole } from "@/lib/db/orgs";
import { requireEnv } from "@/lib/env";
import { getInstallation, githubAppConfig, userControlsInstallation } from "@/lib/github/app";
import { AUTOMATIONS_PATH, completeSetup, INSTALL_COOKIE, INSTALL_COOKIE_PATH } from "@/lib/github/app-setup";

/**
 * The GitHub App's setup URL: GitHub sends the admin here after they install
 * the app or change its repositories. Links the installation to the org the
 * install started from, when `state` matches the install cookie
 * (lib/github/app-setup.ts), then lands on the Automations page.
 */
export async function GET(request: Request) {
  await connection();
  const base = requireEnv("RUNTIME_BASE_URL");
  const to = (path: string) => NextResponse.redirect(new URL(path, base), 303);

  const owner = await getOwner();
  if (!owner) return to(`/signin?next=${encodeURIComponent(AUTOMATIONS_PATH)}`);
  const config = githubAppConfig();
  if (!config) return to(`${AUTOMATIONS_PATH}?problem=not_configured`);

  const jar = await cookies();
  try {
    const path = await completeSetup(
      { userId: owner.id, params: new URL(request.url).searchParams, cookie: jar.get(INSTALL_COOKIE)?.value },
      {
        memberRole,
        getInstallation: (id) => getInstallation(config, id),
        controlsInstallation: async (installation, userId) =>
          userControlsInstallation(config, installation, {
            login: owner.githubLogin,
            token: await getGithubToken(userId),
          }),
        linkInstallation,
      },
    );
    return to(path);
  } finally {
    // Used once, however it went.
    jar.delete({ name: INSTALL_COOKIE, path: INSTALL_COOKIE_PATH });
  }
}
