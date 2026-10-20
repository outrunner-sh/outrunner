import { NextResponse } from "next/server";

import { authMethod, isAgentId } from "@/lib/agents/registry";
import { getOwner } from "@/lib/auth/owner";
import { getAgentAuthChoices, setAgentAuthChoice } from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";

export const dynamic = "force-dynamic";

/**
 * How each of the user's coding agents signs in (Settings → Providers, a card
 * per way, lib/agents/registry.ts). GET says which way each agent is set to;
 * PUT `{ agent, method }` picks one. Only the pick: the credentials are saved
 * where they always were (/api/settings/claude, /api/settings/providers).
 */

export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return savingSettings("agent sign-in", async () =>
    NextResponse.json({ choices: await getAgentAuthChoices(owner.id) }),
  );
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const body = (await request.json().catch(() => null)) as { agent?: unknown; method?: unknown } | null;
  const agent = body?.agent;
  if (!isAgentId(agent)) return NextResponse.json({ error: "Choose one of the agents." }, { status: 400 });
  const method = authMethod(agent, body?.method);
  if (!method) {
    return NextResponse.json({ error: "Choose one of that agent's ways of signing in." }, { status: 400 });
  }
  return savingSettings("agent sign-in", async () => {
    await setAgentAuthChoice(owner.id, agent, method.id);
    return NextResponse.json({ choices: await getAgentAuthChoices(owner.id) });
  });
}
