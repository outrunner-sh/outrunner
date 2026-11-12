import { NextResponse } from "next/server";

import { getAuthUser, getOwner } from "@/lib/auth/owner";
import { createTeamOrg, orgsForDomains, TeamOrgError } from "@/lib/db/orgs";
import { githubErrorResponse } from "@/lib/github/http";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";
import { orgName } from "@/lib/orgs/active";
import { createTeamOrgFor } from "@/lib/orgs/create";
import { setActiveOrg } from "@/lib/orgs/server";
import { verifiedEmailsOf } from "@/lib/orgs/user-emails";

/**
 * Make a team org, `{ name }`, with the signed-in user as its admin, and show
 * it (the active org). It claims the domain of their primary verified email
 * (GitHub's, else Google's) (lib/orgs/create.ts).
 *
 * 409 `domain_org_exists` with `org` when an org already has one of their
 * domains: they ask to join that one instead. 409 `one_team_org` when they've
 * made one already: one each for now.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  const user = await getAuthUser();
  if (!owner || !user) return signInFirst();

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = orgName(body?.name);
  if (!name) return NextResponse.json({ error: "Give the org a name, up to 80 characters." }, { status: 400 });

  try {
    const outcome = await createTeamOrgFor(owner.id, name, {
      verifiedEmails: async () => verifiedEmailsOf(user),
      orgsForDomains,
      create: createTeamOrg,
    });
    if (!outcome.made) {
      const { existing } = outcome;
      return NextResponse.json(
        {
          error: `${existing.name} already uses Outrunner for ${existing.domain}. Ask one of its admins to invite you.`,
          code: "domain_org_exists",
          org: { name: existing.name, domain: existing.domain, memberCount: existing.memberCount },
        },
        { status: 409 },
      );
    }
    await setActiveOrg(outcome.orgId);
    return NextResponse.json({ org: { id: outcome.orgId, name, domain: outcome.domain } }, { status: 201 });
  } catch (error) {
    if (error instanceof TeamOrgError) {
      return NextResponse.json({ error: error.message, code: error.reason }, { status: 409 });
    }
    return (
      databaseNotUpdated(error, "the new org") ??
      githubErrorResponse(error, "Couldn't make the org. Try again.")
    );
  }
}
