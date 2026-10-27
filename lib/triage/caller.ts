import { NextResponse } from "next/server";

import { bearerToken } from "@/lib/auth/cli-login";
import { getCliOwner } from "@/lib/auth/cli-owner";
import { getOwner, type Owner } from "@/lib/auth/owner";
import type { Db } from "@/lib/db/work-items";
import { isSameOriginRequest } from "@/lib/http/guards";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import type { WorkItemSource } from "@/lib/triage/work-items";

/** Who is asking a triage route, the client to answer them on, and the
 *  sources they may say a capture came from. */
export type TriageCaller = {
  owner: Owner;
  db: Db;
  sources: readonly WorkItemSource[];
  /** Signed in with a token (the CLI, a script), not the browser. */
  token: boolean;
};

/**
 * The caller of a triage route: the browser's signed-in user (a write must be
 * same-origin, as everywhere in the app), or, where `allowToken`, the owner a
 * CLI token (`Authorization: Bearer or_cli_…`) names. A token needs no Origin
 * check — a browser never sends one on its own — and runs on the service-role
 * client, which the routes hold to that owner by filtering on them.
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
    return { owner, db: createSupabaseAdminClient(), sources: ["cli", "api"], token: true };
  }
  const reading = request.method === "GET" || request.method === "HEAD";
  if (!reading && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  return { owner, db: await createSupabaseServerClient(), sources: ["app"], token: false };
}
