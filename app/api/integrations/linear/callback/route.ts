import { cookies } from "next/headers";
import { after, NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getOwner } from "@/lib/auth/owner";
import { memberRole } from "@/lib/db/orgs";
import { connectOrgToInstallation, installationByExternalId, installationOrgIds, orgUsesInstallation, saveInstallation, saveTrackerLink } from "@/lib/db/trackers";
import { appUrl } from "@/lib/orgs/notify";
import { resumeLinkedDelegations } from "@/lib/trackers/linear-agent.deps";
import { exchangeLinearCode, LINEAR_COOKIE_PATH, LINEAR_NONCE_COOKIE, linearConfig, linearViewer, revokeLinearToken, verifyLinearState } from "@/lib/trackers/linear";
import { linearCallback } from "@/lib/trackers/linear-callback";

/** Where Linear's OAuth comes back to: lib/trackers/linear-callback.ts decides. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const config = linearConfig();
  const jar = await cookies();
  const nonce = jar.get(LINEAR_NONCE_COOKIE)?.value;
  // Used once, whatever happens next.
  jar.set(LINEAR_NONCE_COOKIE, "", { path: LINEAR_COOKIE_PATH, maxAge: 0 });

  const state = config ? verifyLinearState(url.searchParams.get("state"), config.clientSecret) : null;
  const back = (result: string, kind = state?.kind) =>
    NextResponse.redirect(appUrl(`${kind === "link" ? "/settings/integrations" : "/settings/org/linear"}?linear=${result}`, origin), { status: 303 });
  if (!config) return back("unavailable");

  let actor: Awaited<ReturnType<typeof getOwner>> = null;
  const { result, kind } = await linearCallback(
    { state, nonce, code: url.searchParams.get("code"), error: url.searchParams.get("error") },
    {
      ownerId: async () => {
        actor = await getOwner();
        return actor?.id ?? null;
      },
      memberRole,
      exchange: (code) => exchangeLinearCode(config, code),
      viewer: (token) => linearViewer(token),
      revoke: (token) => revokeLinearToken(token),
      installation: (organizationId) => installationByExternalId("linear", organizationId),
      orgUses: orgUsesInstallation,
      orgIds: installationOrgIds,
      saveInstall: ({ viewer, tokens, ownerId }) =>
        saveInstallation({
          provider: "linear",
          externalId: viewer.organization.id,
          siteUrl: viewer.organization.urlKey ? `https://linear.app/${viewer.organization.urlKey}` : null,
          name: viewer.organization.name,
          appUserId: viewer.id,
          tokens,
          installedBy: ownerId,
        }),
      connectOrg: connectOrgToInstallation,
      audit: (orgId, viewer) =>
        recordAudit({
          orgId,
          actor: actor as NonNullable<typeof actor>,
          action: "tracker.connected",
          resource: { type: "integration", id: "linear", label: "Linear" },
          details: { label: viewer.organization.name ?? viewer.organization.id },
        }),
      saveLink: ({ installationId, viewer, ownerId }) => saveTrackerLink({ installationId, externalUserId: viewer.id, externalName: viewer.name, ownerId }),
      resumeLinked: (installationId, viewerId) =>
        after(() => resumeLinkedDelegations(installationId, viewerId).catch((error: unknown) => console.error("Linear: couldn't carry on after a link", error))),
    },
  );
  return back(result, kind);
}
