import { NextResponse } from "next/server";

import { getAuthUser, getOwner } from "@/lib/auth/owner";
import { requestToJoin } from "@/lib/db/org-members";
import { orgsForDomains } from "@/lib/db/orgs";
import { githubErrorResponse } from "@/lib/github/http";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";
import { primaryDomain } from "@/lib/orgs/domains";
import { emailJoinRequest } from "@/lib/orgs/notify";
import { verifiedEmailsOf } from "@/lib/orgs/user-emails";

/**
 * Ask to join the org that claimed the signed-in user's email domain (their
 * primary verified email's, GitHub's or else Google's): what "New organization" offers when there's
 * one already. Its admins approve or decline.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  const user = await getAuthUser();
  if (!owner || !user) return signInFirst();

  try {
    const emails = await verifiedEmailsOf(user);
    const domain = primaryDomain(emails);
    const [org] = domain ? await orgsForDomains([domain]) : [];
    if (!org) {
      return NextResponse.json({ error: "No org has claimed your email's domain." }, { status: 404 });
    }
    const email = emails.find((e) => e.primary)!.email;
    const outcome = await requestToJoin(org.id, owner.id, email);
    if (outcome === "requested") await emailJoinRequest(org, email, new URL(request.url).origin).catch(() => {});
    const messages = {
      requested: `Asked. ${org.name}'s admins will see your request.`,
      pending: `You've asked already. ${org.name}'s admins will see your request.`,
      member: `You're a member of ${org.name} already: pick it in the org menu.`,
      declined_recently: `${org.name}'s admins declined your request. You can ask again in a few days.`,
    } as const;
    return NextResponse.json({ outcome, org: { name: org.name }, message: messages[outcome] });
  } catch (error) {
    return githubErrorResponse(error, "Couldn't send your request. Try again.");
  }
}
