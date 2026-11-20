import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listAvailableFor, listOrgInstallations } from "@/lib/db/github-installations";
import { githubAppConfig } from "@/lib/github/app";
import { appClientSecret } from "@/lib/github/installer";
import { personalCredential } from "@/lib/github/personal";
import type { GitHubAccess } from "@/lib/onboarding/types";
import { getOrgContext } from "@/lib/orgs/server";

/**
 * Where the org being set up (the active one) gets its repositories
 * (GitHubAccess): the accounts its GitHub App reaches, the installations on
 * GitHub its admin could add to it (as Settings → Org → GitHub offers), and
 * whether the user connected their own GitHub (Settings → Connections).
 * Null before orgs.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const context = await getOrgContext();
  if (!context) return NextResponse.json({ access: null });
  const org = context.active;
  const admin = org.role === "admin";
  const configured = githubAppConfig() !== null;
  const [installations, available, token] = await Promise.all([
    listOrgInstallations(org.id),
    admin && configured ? listAvailableFor(owner.githubId, org.id, owner.id).catch(() => []) : Promise.resolve([]),
    personalCredential(owner.id).catch(() => null),
  ]);
  const kept = new Set(installations.map((i) => i.id));
  const access: GitHubAccess = {
    admin,
    accounts: installations.filter((i) => !i.suspended).map((i) => i.accountLogin),
    available: available.filter((i) => !kept.has(i.id) && !i.suspended).map((i) => ({ id: i.id, accountLogin: i.accountLogin })),
    personalGithub: token !== null,
    appInstallable: configured,
    installNeedsGithub: appClientSecret() === null,
  };
  return NextResponse.json({ access }, { headers: { "cache-control": "no-store" } });
}
