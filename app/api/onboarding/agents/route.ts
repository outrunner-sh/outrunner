import { accountForSession } from "@/lib/codex/grant";
import { AGENT_IDS, AGENTS } from "@/lib/agents/registry";
import { getOwner } from "@/lib/auth/owner";
import { agentAuthStore } from "@/lib/db/credentials";
import { activeOrgId } from "@/lib/orgs/server";

/** Effective cloud methods, including org defaults; never return credentials. */
export async function GET() {
  const owner = await getOwner();
  if (!owner)
    return Response.json({ error: "Sign in first." }, { status: 401 });
  try {
    const org = await activeOrgId();
    const store = agentAuthStore(owner.id, org);
    const entries = await Promise.all(
      AGENT_IDS.map(async (agent) => {
        const state = await store.load(agent);
        const methods = AGENTS[agent].methods
          .filter(
            (m) => m.targets.includes("cloud") && state.open(m.credential),
          )
          .map((m) => m.id);
        if (
          agent === "codex" &&
          !methods.includes("codex-account") &&
          (await accountForSession(
            owner.id,
            org,
            methods.includes("api-key"),
            true,
          ))
        )
          methods.unshift("codex-account");
        return [agent, methods];
      }),
    );
    return Response.json(
      { methods: Object.fromEntries(entries) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Couldn't check your cloud connections. Try again." },
      { status: 503 },
    );
  }
}
