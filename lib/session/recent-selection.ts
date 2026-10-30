import { isAgentId, type AgentId } from "@/lib/agents/registry";
import { offeredModel } from "@/lib/runtime/model-loadout";
import { agentsFor, compatibleEffort, isEffort, matchModel, modelChoice, type Effort, type ModelGroup, type ModelProvider, type SessionModel } from "@/lib/runtime/session-models";
import type { Workspace } from "@/lib/runtime/types";

/** The last session's complete choice, independent of Settings → Default models. */
export type RecentSelection = { provider: ModelProvider; id: string; agent: AgentId; effort: Effort | null };

/** A reported ID alone cannot change whose account a session runs on.
 * Retain a confirmed provider even when its key or catalog entry disappears;
 * the next session checks availability in recentSelectionFor. */
export function sessionModelToRemember(groups: ModelGroup[], reported: string | undefined, pickedProvider?: ModelProvider, recorded?: SessionModel): SessionModel | undefined {
  const provider = pickedProvider ?? recorded?.provider;
  const candidates = provider ? groups.filter((group) => group.provider === provider) : groups;
  return matchModel(candidates, reported, provider)
    ?? (recorded?.id === reported && recorded?.provider === provider ? recorded : undefined)
    ?? (provider ? modelChoice(provider, reported) ?? undefined : undefined);
}

export function parseRecentSelection(raw: unknown): RecentSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const { provider, id, agent, effort } = raw as Record<string, unknown>;
  const model = modelChoice(provider, id);
  if (!model || !isAgentId(agent) || !agentsFor(model.provider).includes(agent) || (effort !== null && !isEffort(effort))) return null;
  return { provider: model.provider, id: model.id, agent, effort };
}

/** Recheck against this target's current credentials, harnesses and catalog.
 * Stored capability metadata must never make an unavailable model eligible. */
export function recentSelectionFor(groups: ModelGroup[], recent: RecentSelection | null, supported?: readonly AgentId[], askedAgent?: AgentId) {
  if (!recent || (askedAgent && recent.agent !== askedAgent) || (supported && !supported.includes(recent.agent))) return null;
  const model = offeredModel(groups, { provider: recent.provider, id: recent.id });
  return model && agentsFor(model.provider).includes(recent.agent)
    ? { model, agent: recent.agent, effort: compatibleEffort(model, recent.effort) }
    : null;
}

/** Cold-start fallback, before this browser has visited a session. Team mates'
 * sessions and deleted rows must not choose the user's next provider. */
export function lastSessionSelection(workspaces: Pick<Workspace, "ownerId" | "agent" | "model" | "status" | "lastActiveAt" | "createdAt" | "updatedAt">[], ownerId: string): RecentSelection | null {
  const recent = workspaces.filter((w) => w.ownerId === ownerId && w.status !== "destroyed" && w.model)
    .sort((a, b) => latest(b) - latest(a))[0];
  return recent?.model ? parseRecentSelection({ ...recent.model.model, agent: recent.agent, effort: recent.model.effort }) : null;
}

function latest(workspace: { lastActiveAt: string | null; createdAt: string; updatedAt: string }): number {
  return Math.max(...[workspace.lastActiveAt, workspace.createdAt, workspace.updatedAt].map((value) => value ? Date.parse(value) || 0 : 0));
}
