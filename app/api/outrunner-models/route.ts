import { codexModelsFor } from "@/lib/codex/model-catalog.deps";
import { NextResponse } from "next/server";

import { getProject, getWorkspace } from "@/lib/db/repositories";
import { resolveProvider } from "@/lib/runtime/resolve";
import type { Workspace } from "@/lib/runtime/types";
import { isUuid } from "@/lib/ids";
import { getSandboxSettings, ownSandboxKeys } from "@/lib/db/credentials";
import { providerForNewSessions } from "@/lib/runtime/sandbox-choice";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import type { AgentConnection, AgentId } from "@/lib/agents/registry";
import { agentConnection, type AgentAuthStore } from "@/lib/agents/resolve";
import { getOwner } from "@/lib/auth/owner";
import { agentAuthStore, modelMenu, offersModels } from "@/lib/db/credentials";
import { getModelLoadout } from "@/lib/db/model-loadout";
import { orgDefaultsFor } from "@/lib/db/org-defaults";
import { withOrgDefault } from "@/lib/orgs/defaults";
import { activeOrgId } from "@/lib/orgs/server";

/**
 * What the user's model menu offers (lib/runtime/session-models.ts): whether
 * the server runs Outrunner's models and on an allowance, and which providers
 * the user has a key for. Never a key itself. `available`: whether a session
 * can start without the user's Claude (a cloud session, or one on a Mac whose
 * Claude Code isn't logged in). `loadout`: the models the picker shows first,
 * and the one a new session starts on (Settings → Default models). `agents`:
 * where sessions can run on the user's own Claude, and Codex
 * (lib/agents/resolve.ts agentConnection), so a menu offers their models only
 * where they're connected. Keys include the active team org's
 * (lib/db/org-credentials.ts), for its cloud sessions. `ownKey`
 * and `serverModels` are for pages loaded before providers; kept for one
 * release.
 */
export async function GET(request: Request) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  // The org being looked at: its keys reach its cloud sessions, never the
  // Mac's, so its agents' connections are cloud ones only.
  const askedWorkspace = new URL(request.url).searchParams.get("workspace");
  // getWorkspace is scoped through RLS. A pending optimistic ID may not exist
  // yet; its creation context is the active org until its row arrives.
  const askedProject = new URL(request.url).searchParams.get("project");
  const project = askedProject && isUuid(askedProject) ? await getProject(askedProject) : null;
  const workspace = askedWorkspace && isUuid(askedWorkspace) ? await getWorkspace(askedWorkspace) : null;
  const orgId = workspace ? workspace.orgId : project ? project.orgId : await activeOrgId().catch(() => undefined);
  const own = agentAuthStore(owner.id);
  const withOrg = orgId ? agentAuthStore(owner.id, orgId) : own;
  const [menu, localMenu, catalog, localCatalog, loadout, claude, codex] = await Promise.all([
    modelMenu(owner.id, orgId),
    modelMenu(owner.id),
    codexModelsFor(withOrg),
    codexModelsFor(own),
    // Where they set no default, the org's (lib/orgs/defaults.ts).
    Promise.all([getModelLoadout(owner.id), orgDefaultsFor(orgId)]).then(([mine, org]) =>
      withOrgDefault(mine, org.defaultModel),
    ),
    connection(own, withOrg, "claude"),
    connection(own, withOrg, "codex"),
  ]);
  return NextResponse.json({
    ...menu,
    codexModels: catalog,
    harnesses: await newSessionHarnesses(owner.id, workspace),
    localMenu: { ...localMenu, codexModels: localCatalog },
    loadout,
    agents: { claude, codex },
    available: offersModels(menu),
    ownKey: menu.keys.includes("openrouter"),
    serverModels: menu.outrunner,
  }, { headers: { "Cache-Control": "private, no-store" } });
}

/** Where `agent` runs on an account: on a box with the org's keys too, on
 *  the Mac with the user's own alone. */
async function connection(own: AgentAuthStore, withOrg: AgentAuthStore, agent: AgentId): Promise<AgentConnection> {
  const [mine, cloud] = await Promise.all([agentConnection(own, agent), agentConnection(withOrg, agent)]);
  return { cloud: cloud.cloud, local: mine.local };
}

async function newSessionHarnesses(user: string, workspace: Workspace | null): Promise<AgentId[]> {
  try {
    const existing = workspace ? resolveProvider(workspace) : null;
    if (existing && !existing.ok) return [];
    const provider = existing?.ok ? existing.provider : providerForNewSessions(await getSandboxSettings(user), ownSandboxKeys(user));
    return isComputerProvider(provider) ? ["claude", "codex"] : ["claude"];
  } catch { return []; }
}
