/**
 * A Jira site's one webhook: every connected project, so an assign or @mention arrives
 * where no rule exists, and rules are checked on our side. Jira can't change a webhook's
 * query, so a change of projects registers a new one, then removes the old. They expire
 * after 30 days, so the tick refreshes them, and starts again rather than let one die.
 */

const LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/** Refreshed at about 25 days. */
export const REFRESH_WITHIN_MS = 5 * 24 * 60 * 60 * 1000;
/** A refresh that keeps failing starts again this long before the end: Atlassian's page
 *  leaves the refresh's path and answer in doubt, and a dead webhook shows nothing. */
export const REREGISTER_WITHIN_MS = 2 * 24 * 60 * 60 * 1000;

export type JiraWebhookDeps = {
  webhookUrl(): string | null;
  install(id: string): Promise<{ provider: string; disconnected: boolean; webhookId: number | null } | null>;
  projects(id: string): Promise<string[]>;
  /** Null: disconnected, so there's no token to do it with. */
  register(id: string, url: string, projects: readonly string[]): Promise<number | null>;
  remove(id: string, webhookId: number): Promise<void>;
  /** Until when it now lasts. Null: Jira no longer has it, or didn't say. */
  refresh(id: string, webhookId: number): Promise<Date | null>;
  save(id: string, webhookId: number | null, expiresAt: Date | null): Promise<void>;
  due(before: number): Promise<{ id: string; webhookId: number; expiresAt: number | null }[]>;
  missing(): Promise<string[]>;
  now(): number;
};

/** Make the site's webhook cover its connected projects now. */
export async function syncJiraWebhook(id: string, deps: JiraWebhookDeps): Promise<void> {
  const url = deps.webhookUrl();
  const install = await deps.install(id);
  if (!url || !install || install.provider !== "jira" || install.disconnected) return;
  const projects = await deps.projects(id);
  if (projects.length === 0 && install.webhookId === null) return;
  let created: number | null = null;
  if (projects.length) {
    created = await deps.register(id, url, projects);
    if (created === null) return;
  }
  // The new one is kept before the old goes: failing here leaves a stray that runs out, not
  // a site with none. Events it doubles meanwhile are deduped (lib/trackers/jira-events.ts).
  await deps.save(id, created, created === null ? null : new Date(deps.now() + LIFE_MS));
  if (install.webhookId !== null) {
    await deps.remove(id, install.webhookId).catch((error: unknown) => console.warn(`Jira: couldn't remove an old webhook of ${id}`, error));
  }
}

/** The tick's part: extend what's due, and register what's missing. How many it changed. */
export async function refreshJiraWebhooks(deps: JiraWebhookDeps): Promise<number> {
  if (!deps.webhookUrl()) return 0;
  const now = deps.now();
  let changed = 0;
  for (const due of await deps.due(now + REFRESH_WITHIN_MS)) {
    try {
      const until = await deps.refresh(due.id, due.webhookId).catch(async (error: unknown) => {
        // Still time to try again later, unless it's nearly gone: then start again.
        if (due.expiresAt !== null && due.expiresAt - now > REREGISTER_WITHIN_MS) throw error;
        console.warn(`Jira: couldn't refresh the webhook of ${due.id}, so it's being registered again`, error);
        return null;
      });
      if (until) await deps.save(due.id, due.webhookId, until);
      else await syncJiraWebhook(due.id, deps);
      changed += 1;
    } catch (error) {
      console.error(`Jira: couldn't refresh the webhook of ${due.id}`, error);
    }
  }
  for (const id of await deps.missing()) {
    try {
      if ((await deps.projects(id)).length === 0) continue;
      await syncJiraWebhook(id, deps);
      changed += 1;
    } catch (error) {
      console.error(`Jira: couldn't register the webhook of ${id}`, error);
    }
  }
  return changed;
}
