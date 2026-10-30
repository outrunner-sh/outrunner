import { onRuntimeComputer, opensInBrowser, type Workspace } from "@/lib/runtime/types";

/**
 * The tabs of a session's right pane, beside its chat. Environment is always
 * there; others join it where the session has what they show. A list, so a
 * new tab is one more entry here and its panel in components/workspace-studio.tsx.
 *
 * Pure (no I/O), so it is unit-tested in Node.
 */

export type InspectorTabId = "environment" | "changes" | "desktop" | "canvas";

export type InspectorTab = { id: InspectorTabId; label: string };

/**
 * The tabs `workspace`'s right pane has, in order: none for a mission, whose
 * pane is its Ships (components/missions/runners-pane.tsx).
 */
export function inspectorTabs(workspace: Pick<Workspace, "provider" | "kind">, local: boolean): InspectorTab[] {
  if (workspace.kind === "mission") return [];
  const tabs: InspectorTab[] = [
    { id: "environment", label: "Environment" },
    { id: "changes", label: "Changes" },
  ];
  // The box's desktop: a cloud session on Daytona, whose computer use runs
  // it. opensInBrowser is that same check (Daytona's signed preview links,
  // which the desktop is viewed through); a session on this Mac has none.
  if (!local && opensInBrowser(workspace.provider)) tabs.push({ id: "desktop", label: "Desktop" });
  if (!local && onRuntimeComputer(workspace.provider)) tabs.push({ id: "canvas", label: "Canvas" });
  return tabs;
}

/** The tab to show: the one chosen while the pane has it, else its first. */
export function shownTab(tabs: InspectorTab[], chosen: InspectorTabId): InspectorTabId | null {
  return tabs.some((tab) => tab.id === chosen) ? chosen : (tabs[0]?.id ?? null);
}
