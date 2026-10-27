import { NextResponse } from "next/server";

import { bearerToken } from "@/lib/auth/cli-login";
import { getCliOwner } from "@/lib/auth/cli-owner";
import { getOwner, type Owner } from "@/lib/auth/owner";
import { triageActor } from "@/lib/db/work-items";
import { isSameOriginRequest } from "@/lib/http/guards";
import { isUuid } from "@/lib/ids";
import { activeOrgId } from "@/lib/orgs/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { TriageActor } from "@/lib/triage/access";
import type { WorkItemSource } from "@/lib/triage/work-items";

/** Who is asking a triage route, as a triager in the org it acts in, and the
 *  sources they may say a capture came from. */
export type TriageCaller = {
  owner: Owner;
  actor: TriageActor;
  sources: readonly WorkItemSource[];
  /** Signed in with a token (the CLI, a script), not the browser. */
  token: boolean;
};

/**
 * The caller of a triage route: the browser's signed-in user, in the org the
 * app is showing (a write must be same-origin, as everywhere in the app); or,
 * where `allowToken`, the owner a CLI token (`Authorization: Bearer
 * or_cli_…`) names, in the org `?org=` names (an id or a name), else their
 * personal one. A token needs no Origin check: a browser never sends one on
 * its own.
 */
export async function triageCaller(
  request: Request,
  { allowToken = false }: { allowToken?: boolean } = {},
): Promise<TriageCaller | NextResponse> {
  if (allowToken && bearerToken(request.headers)) {
    const owner = await getCliOwner(request);
    if (!owner) {
      return NextResponse.json({ error: "Not signed in. Run `outrunner login`." }, { status: 401 });
    }
    const wanted = new URL(request.url).searchParams.get("org");
    const orgId = await memberOrgId(owner.id, wanted);
    if (!orgId) {
      return NextResponse.json(
        { error: wanted ? `You aren't a member of an org named ${wanted}.` : "You aren't in an org yet." },
        { status: 404 },
      );
    }
    return withActor(owner, orgId, ["cli", "api"], true);
  }
  const reading = request.method === "GET" || request.method === "HEAD";
  if (!reading && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const orgId = await activeOrgId();
  if (!orgId) return NextResponse.json({ error: "You aren't in an org yet." }, { status: 404 });
  return withActor(owner, orgId, ["app"], false);
}

async function withActor(
  owner: Owner,
  orgId: string,
  sources: readonly WorkItemSource[],
  token: boolean,
): Promise<TriageCaller | NextResponse> {
  const actor = await triageActor(owner.id, orgId);
  if (!actor) return NextResponse.json({ error: "You aren't a member of that org." }, { status: 403 });
  return { owner, actor, sources, token };
}

/**
 * One of the user's orgs: the one `wanted` names (its id, or its name, any
 * case), else their personal org. Null when they're in none such.
 */
export async function memberOrgId(userId: string, wanted: string | null): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_members")
    .select("org_id, organizations (id, name, personal_owner_id)")
    .eq("user_id", userId);
  if (error) throw error;
  const orgs = (data ?? []).flatMap((m) => {
    const org = m.organizations as unknown as { id: string; name: string; personal_owner_id: string | null } | null;
    return org ? [org] : [];
  });
  const name = wanted?.trim().toLowerCase();
  if (!name) return orgs.find((o) => o.personal_owner_id === userId)?.id ?? orgs[0]?.id ?? null;
  return (isUuid(name) ? orgs.find((o) => o.id === name) : orgs.find((o) => o.name.toLowerCase() === name))?.id ?? null;
}
