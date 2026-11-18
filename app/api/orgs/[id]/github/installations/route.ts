import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getGithubConnection } from "@/lib/db/github-connections";
import { ClaimError, claimInstallation } from "@/lib/db/github-installations";
import { getInstallation, githubAppConfig } from "@/lib/github/app";
import { syncConnectedInstallation } from "@/lib/github/connect-installation.deps";
import { orgCaller } from "@/lib/orgs/routes";

/**
 * Connect an installation to the org, `{ installationId }`, including one
 * already connected to another org. GitHub must vouch for it: the admin is
 * its installer, or owns its GitHub account or organization. Its repositories
 * become the org's projects at once; `synced` says how many, null when they
 * couldn't be added (Sync repositories tries again).
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
    // The GitHub accounts GitHub has vouched are theirs: their sign-in's, and
    // the one they connected for repositories.
    const connected = await getGithubConnection(caller.owner.id).catch(() => null);
    await claimInstallation({
      orgId: id,
      installation,
      githubIds: [caller.owner.githubId, connected && !connected.broken ? connected.githubUserId : null],
      userId: caller.owner.id,
    });
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "github.installed",
      resource: { type: "installation", id: String(installation.id), label: installation.accountLogin },
    });
    const synced = await syncConnectedInstallation(caller.owner.id, id, installation.id);
    return NextResponse.json({ claimed: installationId, synced });
  } catch (error) {
    if (error instanceof ClaimError) {
      const message =
        error.reason === "not_installer"
          ? "Only whoever installed it on GitHub, or an owner of the GitHub account or organization it's installed on, can connect it to an org."
          : error.reason === "not_admin"
            ? "You must administer this org to connect it."
            : "Outrunner hasn't heard of this installation from GitHub.";
      return NextResponse.json({ error: message, code: error.reason }, { status: 409 });
    }
    console.error(`Could not claim installation ${installationId}`, error);
    return NextResponse.json({ error: "Couldn't do that. Try again." }, { status: 500 });
  }
}
