import { NextResponse } from "next/server";

import { isAgentId } from "@/lib/agents/registry";
import { AgentAuthError, resolveAgentAuth } from "@/lib/agents/resolve";
import { getOwner } from "@/lib/auth/owner";
import { agentAuthStore } from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";

/**
 * What a local session's agent signs in with (lib/agents/resolve.ts): the
 * user's pick for it, and the credential that pick needs, if it needs one the
 * Mac doesn't have. A local session's page hands it to the agent on the
 * user's Mac (POST /workspaces/{id}/auth there), as it does a model's key
 * (/api/outrunner-models/key). POST, same-origin, never cached: it can hold a
 * credential.
 *
 * 409 with `settingsHref` when the pick can't run: its key isn't saved.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { agent?: unknown } | null;
  if (!isAgentId(body?.agent)) return NextResponse.json({ error: "Choose one of the agents." }, { status: 400 });
  try {
    const auth = await resolveAgentAuth(agentAuthStore(owner.id), body.agent, "local");
    return NextResponse.json(auth, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentAuthError) {
      return NextResponse.json({ error: error.message, settingsHref: error.settingsHref }, { status: 409 });
    }
    console.error(`Could not resolve how ${body.agent} signs in for ${owner.id}`, error);
    return NextResponse.json({ error: "Couldn't read how the agent signs in. Try again." }, { status: 500 });
  }
}
