import { optionalEnv } from "@/lib/env";
import { itemHref, type WorkItem } from "@/lib/triage/work-items";

/** The item's page as a full link, for a reply outside the app (Slack, the
 *  CLI); the bare path when the app's origin isn't configured. */
export function itemUrl(item: Pick<WorkItem, "id">): string {
  const base = optionalEnv("RUNTIME_BASE_URL");
  try {
    return base ? new URL(itemHref(item), base).toString() : itemHref(item);
  } catch {
    return itemHref(item);
  }
}
