/**
 * GET /models: the models the key's maker can start a session on, read as
 * the new-session menu reads them (their accounts, keys and Outrunner's), with
 * their loadout and their org's default for the one a session starts on.
 */

import { agentConnection } from "@/lib/agents/resolve";
import type { AgentId } from "@/lib/agents/registry";
import type { ApiContext } from "@/lib/api/handler";
import { modelsJson } from "@/lib/api/models";
import { codexModelsFor } from "@/lib/codex/model-catalog.deps";
import { agentAuthStore, modelMenu } from "@/lib/db/credentials";
import { getModelLoadout } from "@/lib/db/model-loadout";
import { orgDefaultsFor } from "@/lib/db/org-defaults";
import { withOrgDefault } from "@/lib/orgs/defaults";
import { modelGroups } from "@/lib/runtime/session-models";

/** GET /models. */
export async function listModelsApi(context: ApiContext): Promise<Response> {
  const { owner, caller } = context;
  const store = agentAuthStore(owner.id, caller.orgId);
  const [menu, mine, orgDefaults, claude, codex, catalog] = await Promise.all([
    modelMenu(owner.id, caller.orgId), getModelLoadout(owner.id), orgDefaultsFor(caller.orgId),
    agentConnection(store, "claude"), agentConnection(store, "codex"), codexModelsFor(store),
  ]);
  const accounts: AgentId[] = [...(claude.cloud ? ["claude" as const] : []), ...(codex.cloud ? ["codex" as const] : [])];
  const groups = modelGroups({ ...menu, codexModels: catalog }, accounts);
  return Response.json(modelsJson(groups, withOrgDefault(mine, orgDefaults.defaultModel)));
}
