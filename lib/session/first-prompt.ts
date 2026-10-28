/**
 * A new cloud session's first prompt, from the new-session screen. It opens the
 * session before its box is ready, so the prompt waits for it twice over: in
 * the URL (?prompt=, ?attachment=), and in this tab's sessionStorage, so it
 * still goes if the user leaves the session while it sets up and comes back to
 * it from the sidebar. The session page moves the URL's copy into the kept one
 * as it opens, where storage allows, so the URL never carries it into a
 * reload; it sends whichever it finds, then forgets both. The kept copy is
 * marked as its send leaves, so a reload mid-send doesn't send it twice.
 *
 * Each carries its idempotency key (?promptKey=, and in the kept copy), made
 * once with the prompt: every send of it, a reload's or Send it again's,
 * names the same key, and the message route sends it to Claude once per
 * session however often it is asked (lib/session/first-prompt-claim.ts).
 */
import { replaceAddressBar } from "@/lib/client/address-bar";

export type FirstPrompt = { prompt: string; attachmentIds: string[]; key?: string };

type PromptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY_PREFIX = "outrunner:first-prompt:";

/** A fresh first prompt, with the key its every send names. */
export function newFirstPrompt(prompt: string, attachmentIds: string[]): FirstPrompt {
  return { prompt, attachmentIds, key: crypto.randomUUID() };
}

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
  if (params.size > 0 && first.key) params.set("promptKey", first.key);
  return params.size > 0 ? `?${params}` : "";
}

/** The first prompt `url` carries, if any (the session page's ?prompt=, ?attachment=). */
export function firstPromptFromUrl(url: URL): FirstPrompt | null {
  const first: FirstPrompt = {
    prompt: url.searchParams.get("prompt") ?? "",
    attachmentIds: url.searchParams.getAll("attachment"),
  };
  const key = url.searchParams.get("promptKey");
  return hasFirstPrompt(first) ? { ...first, ...(key && { key }) } : null;
}

/** `url` without the first prompt, once it has gone: a reload must not send it again. */
export function withoutFirstPrompt(url: URL): string {
  const next = new URL(url);
  next.searchParams.delete("prompt");
  next.searchParams.delete("attachment");
  next.searchParams.delete("promptKey");
  return `${next.pathname}${next.search}${next.hash}`;
}

/**
 * Take the first prompt out of the address bar, in place, and out of Next's
 * router with it (see replaceAddressBar): otherwise the router.refresh after
 * the first prompt names the session would put ?prompt= back, and a reload
 * then sends the prompt again.
 */
export function dropFirstPromptFromAddressBar(): void {
  replaceAddressBar(withoutFirstPrompt(new URL(window.location.href)));
}

/**
 * Move the first prompt `url` carries into the session's kept copy, and say
 * where the page should be instead: `url` without it, so a reload can't send it
 * again, while the kept copy still sends it after a reload during setup. Null
 * when there is nothing to move, or storage won't keep it: the URL then stays
 * its only carrier until it goes.
 */
export function keepFirstPromptFromUrl(storage: PromptStorage | null, workspaceId: string, url: URL): string | null {
  const first = firstPromptFromUrl(url);
  if (!first) return null;
  // The new-session screen kept it already, and a send may have marked it
  // going: rewriting it would drop the mark.
  if (!rememberedFirstPrompt(storage, workspaceId)) rememberFirstPrompt(storage, workspaceId, first);
  return rememberedFirstPrompt(storage, workspaceId) ? withoutFirstPrompt(url) : null;
}

/** Keep `first` for the session until it is sent. Storage refusing (private
 *  mode, full) only loses the copy the URL doesn't carry. */
export function rememberFirstPrompt(storage: PromptStorage | null, workspaceId: string, first: FirstPrompt): void {
  if (!storage || !hasFirstPrompt(first)) return;
  try {
    storage.setItem(
      key(workspaceId),
      JSON.stringify({ prompt: first.prompt.trim(), attachmentIds: first.attachmentIds, ...(first.key && { key: first.key }) }),
    );
  } catch {
    // The URL still carries it.
  }
}

/** The first prompt kept for the session, if one is still waiting to go. */
export function rememberedFirstPrompt(storage: PromptStorage | null, workspaceId: string): FirstPrompt | null {
  return readKept(storage, workspaceId)?.first ?? null;
}

/** The kept copy as stored: the prompt, and whether its send has left. */
function readKept(storage: PromptStorage | null, workspaceId: string): { first: FirstPrompt; going: boolean } | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key(workspaceId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { prompt?: unknown; attachmentIds?: unknown; key?: unknown; going?: unknown };
    const first: FirstPrompt = {
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      attachmentIds: Array.isArray(parsed.attachmentIds)
        ? parsed.attachmentIds.filter((id): id is string => typeof id === "string")
        : [],
      ...(typeof parsed.key === "string" && parsed.key && { key: parsed.key }),
    };
    return hasFirstPrompt(first) ? { first, going: parsed.going === true } : null;
  } catch {
    return null;
  }
}

/**
 * Mark the kept copy as going, synchronously as its send leaves, or back to
 * waiting when the send fails. A page that reloads in between finds the mark
 * (firstPromptCutOff); one that never sent leaves the copy as it was.
 */
export function markFirstPromptGoing(storage: PromptStorage | null, workspaceId: string, going: boolean): void {
  const kept = readKept(storage, workspaceId);
  if (!storage || !kept) return;
  try {
    storage.setItem(key(workspaceId), JSON.stringify({ ...kept.first, ...(going && { going: true }) }));
  } catch {
    // Unmarked, a reload mid-send can send it again: as without storage.
  }
}

/**
 * Whether a send of the session's first prompt was cut off: its kept copy is
 * marked going, but no send of this page load has it. Only a reload (or a
 * closed tab, restored) does that, and the prompt most likely reached Claude
 * anyway: the server carries on with a request whose page has gone. So the page
 * doesn't send it again unasked; for the rare send that never got there (a
 * reload before it left, the route failing after), it offers it again. That
 * resend names the prompt's key, so if the first got there after all the
 * server sends nothing (lib/session/first-prompt-claim.ts).
 */
export function firstPromptCutOff(storage: PromptStorage | null, workspaceId: string): boolean {
  if (sending.has(workspaceId) || sent.has(workspaceId)) return false;
  return readKept(storage, workspaceId)?.going ?? false;
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
