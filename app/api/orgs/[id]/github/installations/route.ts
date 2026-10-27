import { NextResponse } from "next/server";

import { ClaimError, claimInstallation } from "@/lib/db/github-installations";
import { getInstallation, githubAppConfig } from "@/lib/github/app";
import { orgCaller } from "@/lib/orgs/routes";

/**
 * Claim an installation for the org, `{ installationId }`: one no org has
 * claimed, that the signed-in admin installed on GitHub (what Settings → Org
 * → GitHub offers when GitHub's word of the install came after them).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const config = githubAppConfig();
  if (!config) return NextResponse.json({ error: "The GitHub App isn't set up here." }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { installationId?: unknown } | null;
  const installationId = Number(body?.installationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return NextResponse.json({ error: "No such installation." }, { status: 404 });
  }
  try {
    const installation = await getInstallation(config, installationId);
    if (!installation) return NextResponse.json({ error: "GitHub has no such installation." }, { status: 404 });
    await claimInstallation({ orgId: id, installation, githubId: caller.owner.githubId, userId: caller.owner.id });
    return NextResponse.json({ claimed: installationId });
  } catch (error) {
    if (error instanceof ClaimError) {
      const message =
        error.reason === "taken"
          ? "Another Outrunner org has this installation."
          : error.reason === "not_installer"
            ? "Only whoever installed it on GitHub can add it to an org."
            : "Outrunner hasn't heard of this installation from GitHub.";
      return NextResponse.json({ error: message, code: error.reason }, { status: 409 });
    }
    console.error(`Could not claim installation ${installationId}`, error);
    return NextResponse.json({ error: "Couldn't do that. Try again." }, { status: 500 });
  }
}
