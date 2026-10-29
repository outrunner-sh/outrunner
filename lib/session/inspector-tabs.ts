import { opensInBrowser, type Workspace } from "@/lib/runtime/types";

/**
 * The tabs of a session's right pane, beside its chat. Environment is always
 * there; others join it where the session has what they show. A list, so a
 * new tab is one more entry here and its panel in components/workspace-studio.tsx.
 *
 * Pure (no I/O), so it is unit-tested in Node.
 */

export type InspectorTabId = "environment" | "desktop";

export type InspectorTab = { id: InspectorTabId; label: string };

/**
 * The tabs `workspace`'s right pane has, in order: none for a mission, whose
 * pane is its Ships (components/missions/runners-pane.tsx). The pane shows a
 * tab strip only when there are two or more.
 */
export function inspectorTabs(workspace: Pick<Workspace, "provider" | "kind">, local: boolean): InspectorTab[] {
  if (workspace.kind === "mission") return [];
  const tabs: InspectorTab[] = [{ id: "environment", label: "Environment" }];
  // The box's desktop: a cloud session on Daytona, whose computer use runs
  // it. opensInBrowser is that same check (Daytona's signed preview links,
  // which the desktop is viewed through); a session on this Mac has none.
  if (!local && opensInBrowser(workspace.provider)) tabs.push({ id: "desktop", label: "Desktop" });
  return tabs;
}

/** The tab to show: the one chosen while the pane has it, else its first. */
export function shownTab(tabs: InspectorTab[], chosen: InspectorTabId): InspectorTabId | null {
  return tabs.some((tab) => tab.id === chosen) ? chosen : (tabs[0]?.id ?? null);
}
