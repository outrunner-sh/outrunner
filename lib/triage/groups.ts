import type { WorkItem, WorkItemStatus } from "@/lib/triage/work-items";

/** The triage page's tabs: what waits to be sorted, what was accepted, and
 *  what is finished with. */
export type TriageTab = "triage" | "backlog" | "closed";

export const TRIAGE_TABS: { id: TriageTab; label: string }[] = [
  { id: "triage", label: "Triage" },
  { id: "backlog", label: "Backlog" },
  { id: "closed", label: "Closed" },
];

const TAB_STATUSES: Record<TriageTab, readonly WorkItemStatus[]> = {
  triage: ["triage"],
  backlog: ["todo", "in_progress"],
  closed: ["done", "declined", "duplicate"],
};

export function tabOf(status: WorkItemStatus): TriageTab {
  return (Object.keys(TAB_STATUSES) as TriageTab[]).find((tab) => TAB_STATUSES[tab].includes(status)) ?? "triage";
}

export type WorkItemGroup = {
  /** The project id; "" is Unsorted. */
  key: string;
  label: string;
  items: WorkItem[];
};

/**
 * A tab's items, by workspace: Unsorted first (it is what triage is for),
 * then the workspaces by name. Within each, the most recently changed first,
 * as the list arrives. A workspace the list doesn't know (since removed from
 * the sidebar) is still named by its id rather than dropped.
 */
export function groupWorkItems(
  items: WorkItem[],
  projects: { id: string; fullName: string }[],
  tab: TriageTab,
): WorkItemGroup[] {
  const names = new Map(projects.map((p) => [p.id, p.fullName]));
  const groups = new Map<string, WorkItemGroup>();
  for (const item of items) {
    if (!TAB_STATUSES[tab].includes(item.status)) continue;
    const key = item.projectId ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { key, label: key ? (names.get(key) ?? "Workspace") : "Unsorted", items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.key) return -1;
    if (!b.key) return 1;
    return a.label.localeCompare(b.label);
  });
}

/** How many items each tab holds. */
export function tabCounts(items: WorkItem[]): Record<TriageTab, number> {
  const counts: Record<TriageTab, number> = { triage: 0, backlog: 0, closed: 0 };
  for (const item of items) counts[tabOf(item.status)] += 1;
  return counts;
}
