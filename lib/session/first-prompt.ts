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

/** First prompts this tab is sending, by session, and the ones it has sent. */
const sending = new Map<string, Promise<boolean>>();
const sent = new Set<string>();

/**
 * Send a session's first prompt through `send`, once per tab however often its
 * page mounts. A page mounted again while an earlier one is still sending it
 * (left, and back through the sidebar) waits on that send instead of sending
 * again, so Claude never gets it twice; if that send fails, this page sends it
 * itself, so the failure shows where the user is looking rather than on a page
 * long gone. "already" when another page of this tab sent it.
 */
export async function sendFirstPromptOnce(
  workspaceId: string,
  send: () => Promise<boolean>,
): Promise<"sent" | "failed" | "already"> {
  if (sent.has(workspaceId)) return "already";
  const earlier = sending.get(workspaceId);
  if (earlier) {
    if (await earlier) return "already";
    return sendFirstPromptOnce(workspaceId, send);
  }
  const attempt = send().catch(() => false);
  sending.set(workspaceId, attempt);
  const delivered = await attempt;
  if (sending.get(workspaceId) === attempt) sending.delete(workspaceId);
  if (delivered) sent.add(workspaceId);
  return delivered ? "sent" : "failed";
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

/** Hand the waiting prompt from one session to another, as Start over does:
 * the copy moves, so only the fresh session can send it. */
export function handOverFirstPrompt(storage: PromptStorage | null, from: string, to: string): FirstPrompt | null {
  const first = rememberedFirstPrompt(storage, from);
  if (!first) return null;
  rememberFirstPrompt(storage, to, first);
  forgetFirstPrompt(storage, from);
  return first;
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
