/**
 * What every org route checks first: the request is the app's own, someone
 * is signed in, the org id is one, and (for an admin's change) they're one of
 * its admins. Each check answers as the routes answer.
 */

import { NextResponse } from "next/server";

import { getOwner, type Owner } from "@/lib/auth/owner";
import { MemberChangeError } from "@/lib/db/org-members";
import { memberRole } from "@/lib/db/orgs";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import type { OrgRole } from "@/lib/orgs/active";

export type OrgCaller = { owner: Owner; role: OrgRole };

/** The signed-in caller and their role in `orgId`, or the answer to give:
 *  403 for another site, 401 signed out, 404 for an org they aren't in, and
 *  403 when `admin` is asked and they're a member. */
export async function orgCaller(
  request: Request,
  orgId: string,
  { admin }: { admin: boolean },
): Promise<OrgCaller | Response> {
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  if (!isUuid(orgId)) return NextResponse.json({ error: "No such org." }, { status: 404 });
  const role = await memberRole(orgId, owner.id);
  if (!role) return NextResponse.json({ error: "No such org." }, { status: 404 });
  if (admin && role !== "admin") {
    return NextResponse.json({ error: "Only the org's admins can do that." }, { status: 403 });
  }
  return { owner, role };
}

/** Run a change to an org's members, answering a refusal (the last admin,
 *  a used invite) as 409 with its reason. */
export async function changingMembers(what: string, change: () => Promise<Response>): Promise<Response> {
  try {
    return await change();
  } catch (error) {
    if (error instanceof MemberChangeError) {
      return NextResponse.json({ error: error.message, code: error.reason }, { status: 409 });
    }
    const notUpdated = databaseNotUpdated(error, what);
    if (notUpdated) return notUpdated;
    console.error(`Could not change ${what}`, error);
    return NextResponse.json({ error: "Couldn't make that change. Try again." }, { status: 500 });
  }
}

/** A role as posted, or null for anything else. */
export function postedRole(value: unknown): OrgRole | null {
  return value === "admin" || value === "member" ? value : null;
}

/** An email as an invite keeps it: trimmed, lower case; null for one that
 *  isn't an email. */
export function inviteEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}
