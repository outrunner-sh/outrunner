/**
 * A new cloud session's first prompt, from the new-session screen. It opens the
 * session before its box is ready, so the prompt waits for it twice over: in
 * the URL (?prompt=, ?attachment=), and in this tab's sessionStorage, so it
 * still goes if the user leaves the session while it sets up and comes back to
 * it from the sidebar. The session page sends whichever it finds, then forgets
 * both.
 */
export type FirstPrompt = { prompt: string; attachmentIds: string[] };

type PromptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY_PREFIX = "outrunner:first-prompt:";

/**
 * This tab's sessionStorage, or null where the browser refuses it: reading
 * `window.sessionStorage` itself throws when storage is blocked, so it is
 * reached only through here. Without it the URL still carries the prompt.
 */
export function tabStorage(): PromptStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Sessions whose first prompt a page of this tab is sending, or has sent. */
const claimed = new Set<string>();

/**
 * Claim the sending of a session's first prompt for this tab. A session page
 * mounted again while the first is still sending (left, and back through the
 * sidebar) finds it claimed and sends nothing, so Claude never gets it twice.
 * False when it is already claimed.
 */
export function claimFirstPrompt(workspaceId: string): boolean {
  if (claimed.has(workspaceId)) return false;
  claimed.add(workspaceId);
  return true;
}

/** The send didn't go: let the next session page try it again. */
export function releaseFirstPrompt(workspaceId: string): void {
  claimed.delete(workspaceId);
}

function key(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`;
}

/** Whether there is anything to send: text, or attachments alone. */
export function hasFirstPrompt(first: FirstPrompt): boolean {
  return first.prompt.trim().length > 0 || first.attachmentIds.length > 0;
}

/** The session page's query for `first`: empty when there is nothing to send. */
export function firstPromptQuery(first: FirstPrompt): string {
  const params = new URLSearchParams();
  const prompt = first.prompt.trim();
  if (prompt) params.set("prompt", prompt);
  for (const id of first.attachmentIds) params.append("attachment", id);
  return params.size > 0 ? `?${params}` : "";
}

/** `url` without the first prompt, once it has gone: a reload must not send it again. */
export function withoutFirstPrompt(url: URL): string {
  const next = new URL(url);
  next.searchParams.delete("prompt");
  next.searchParams.delete("attachment");
  return `${next.pathname}${next.search}${next.hash}`;
}

/** Keep `first` for the session until it is sent. Storage refusing (private
 *  mode, full) only loses the copy the URL doesn't carry. */
export function rememberFirstPrompt(storage: PromptStorage | null, workspaceId: string, first: FirstPrompt): void {
  if (!storage || !hasFirstPrompt(first)) return;
  try {
    storage.setItem(key(workspaceId), JSON.stringify({ prompt: first.prompt.trim(), attachmentIds: first.attachmentIds }));
  } catch {
    // The URL still carries it.
  }
}

/** The first prompt kept for the session, if one is still waiting to go. */
export function rememberedFirstPrompt(storage: PromptStorage | null, workspaceId: string): FirstPrompt | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key(workspaceId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { prompt?: unknown; attachmentIds?: unknown };
    const first: FirstPrompt = {
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      attachmentIds: Array.isArray(parsed.attachmentIds)
        ? parsed.attachmentIds.filter((id): id is string => typeof id === "string")
        : [],
    };
    return hasFirstPrompt(first) ? first : null;
  } catch {
    return null;
  }
}

/** The session's first prompt has gone (or never will): drop the kept copy. */
export function forgetFirstPrompt(storage: PromptStorage | null, workspaceId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key(workspaceId));
  } catch {
    // Nothing kept, or nothing to do about it.
  }
}
