import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getGithubToken } from "@/lib/db/credentials";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { githubAppConfig } from "@/lib/github/app";
import type { GitHubAccess } from "@/lib/onboarding/types";
import { getOrgContext } from "@/lib/orgs/server";

/**
 * Where onboarding's repositories come from (GitHubAccess): the user's orgs,
 * the accounts each one's GitHub App reaches, and whether they signed in
 * with GitHub. Null before orgs.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const context = await getOrgContext();
  if (!context) return NextResponse.json({ access: null });
  const [orgs, token] = await Promise.all([
    Promise.all(
      context.orgs.map(async (org) => ({
        id: org.id,
        name: org.name,
        personal: org.personal,
        admin: org.role === "admin",
        accounts: (await listOrgInstallations(org.id)).filter((i) => !i.suspended).map((i) => i.accountLogin),
      })),
    ),
    getGithubToken(owner.id).catch(() => null),
  ]);
  const access: GitHubAccess = {
    orgs,
    activeOrgId: context.active.id,
    personalGithub: token !== null,
    appInstallable: githubAppConfig() !== null,
  };
  return NextResponse.json({ access }, { headers: { "cache-control": "no-store" } });
}
