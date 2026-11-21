import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getOwner } from "@/lib/auth/owner";
import { type GitHubJoinOutcome, joinOrgViaGithub, setAdmitted } from "@/lib/db/org-members";
import { getOrg } from "@/lib/db/orgs";
import { githubErrorResponse } from "@/lib/github/http";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import { verifyGithubJoin } from "@/lib/orgs/github-join";
import { githubJoinDeps } from "@/lib/orgs/github-join.deps";
import { setActiveOrg } from "@/lib/orgs/server";

type Refusal = Exclude<GitHubJoinOutcome, "joined" | "member">;

const ASK_FOR_AN_INVITE = "Ask one of its admins to invite you.";

/**
 * Join team org `id` as a member through its GitHub organization, at once:
 * what "New organization" offers someone GitHub says is an active member of the
 * GitHub organization the org's source installation is on
 * (lib/orgs/github-join.ts). GitHub is asked again here, whatever the
 * browser says; the database checks the rest (join_org_via_github). Joined,
 * they're let in past the allowlist, as an accepted invite lets them, and
 * the app shows the org.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "No such org." }, { status: 404 });

  try {
    const org = await getOrg(id);
    if (!org) return NextResponse.json({ error: "No such org." }, { status: 404 });
    const check = await verifyGithubJoin(owner.id, id, githubJoinDeps);
    if (!check.ok) {
      return check.reason === "not_connected"
        ? NextResponse.json(
            { error: "Connect GitHub first: it's how Outrunner knows your GitHub organizations.", code: "github_not_connected" },
            { status: 409 },
          )
        : NextResponse.json(
            {
              // Not the org's name: nothing's been shown to be theirs to see yet.
              error: `GitHub didn't confirm you're a member of this org's GitHub organization. ${ASK_FOR_AN_INVITE}`,
              code: "unverified",
            },
            { status: 403 },
          );
    }

    const outcome = await joinOrgViaGithub(id, owner.id, check.githubOrg, check.installationId);
    if (outcome !== "joined" && outcome !== "member") {
      const messages: Record<Refusal, string> = {
        disabled: `${org.name}'s admins have turned off joining through GitHub. ${ASK_FOR_AN_INVITE}`,
        not_source: `${org.name} no longer lets members of ${check.githubOrg} in this way. ${ASK_FOR_AN_INVITE}`,
        removed: `An admin of ${org.name} removed you from it. ${ASK_FOR_AN_INVITE}`,
      };
      return NextResponse.json({ error: messages[outcome], code: outcome }, { status: 403 });
    }
    if (outcome === "joined") {
      await recordAudit({
        orgId: id,
        actor: owner,
        action: "member.joined",
        resource: { type: "member", id: owner.id, label: owner.githubLogin || owner.email || owner.name },
        details: { role: "member", via: "github", githubOrg: check.githubOrg },
      });
    }
    // Joined now or before. Failing these only delays, as for an accepted invite
    // (app/api/invites/accept): they're admitted at their next sign-in, as a
    // team org's member, and can pick the org in the switcher.
    await setAdmitted(owner.id, true).catch((error: unknown) => console.error(`Could not admit ${owner.id}`, error));
    await setActiveOrg(id).catch((error: unknown) => console.error(`Could not show org ${id}`, error));
    return NextResponse.json({ outcome, org: { id, name: org.name } });
  } catch (error) {
    return databaseNotUpdated(error, "joining through GitHub") ?? githubErrorResponse(error, "Couldn't join the org. Try again.");
  }
}
