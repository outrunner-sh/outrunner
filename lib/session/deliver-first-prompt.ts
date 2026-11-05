/**
 * A session's first prompt as the server keeps it for the session while its
 * box starts (workspaces.first_prompt, lib/db/repositories.ts): until now it
 * waited only in the tab that made it (sessionStorage), so a tab closed
 * during startup — a laptop shut, a browser refreshed away — lost it for
 * good. The kept copy is stored as the session is made, and this is its
 * delivery, by setup itself once the box is ready (lib/session/
 * create-cloud-session.ts). The session page holds its own copy of the same
 * prompt (lib/session/first-prompt.ts) and can deliver that first: both name
 * the key the prompt was made with, so its claim
 * (lib/session/first-prompt-claim.ts) lets only one of them send it, and the
 * box gets it exactly once however they race.
 */
import type { StoredFirstPrompt } from "@/lib/runtime/types";
import type { FirstPromptGate } from "@/lib/session/first-prompt-claim";
import { firstPromptKey } from "@/lib/session/first-prompt-claim";

/** What delivering a kept first prompt needs, injected so the delivery tests
 *  without a database or a box. */
export type FirstPromptDeliveryDeps = {
  read: () => Promise<StoredFirstPrompt | null>;
  /** Claim the prompt for its key, as the message route does (gateFirstPrompt). */
  gate: (key: string) => Promise<FirstPromptGate>;
  /** Put the prompt's attachments on the box, naming them in it
   *  (materializeAttachments). */
  attach: (prompt: string, attachmentIds: string[]) => Promise<string>;
  /** Hand the prompt to the session's agent; what it answers is no one's
   *  business here, only whether it throws. */
  send: (prompt: string) => Promise<unknown>;
  /** The kept copy is spent, its session holding the only one left: drop it. */
  clear: () => Promise<void>;
  /** The session now has work to do: watch it (lib/session/watch.ts). */
  watch: () => Promise<void>;
};

/** The first prompt to keep for a session being made, from the new-session
 *  screen's own ask: its text (which named the session already), its
 *  attachments, and the key its every send names. Null without the key —
 *  a client from before the server kept prompts carries its own copy as it
 *  always did, and a session the server starts (an automation's, the API's)
 *  sends its first message its own way — so this never speaks for either.
 */
export function firstPromptToKeep(body: {
  prompt?: unknown;
  promptKey?: unknown;
  attachmentIds?: unknown;
}): StoredFirstPrompt | null {
  const key = firstPromptKey(body.promptKey);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? body.attachmentIds.filter((id): id is string => typeof id === "string")
    : [];
  return key && (prompt || attachmentIds.length > 0) ? { prompt, attachmentIds, key } : null;
}

/**
 * Deliver the first prompt kept for `label`'s session, or stand down for
 * whoever else is delivering it. Never throws: a session that started fine
 * isn't failed by its prompt, which stays kept for the page to send.
 */
export async function deliverStoredFirstPrompt(deps: FirstPromptDeliveryDeps, label: string): Promise<void> {
  let stored: StoredFirstPrompt | null;
  try {
    stored = await deps.read();
  } catch (error) {
    console.error(`First prompt: couldn't read the one kept for ${label}`, error);
    return;
  }
  if (!stored) return;
  const gate = await deps.gate(stored.key);
  // The page's own copy went: its marking sent clears the kept one. Cleared
  // here too, for a send by a server from before this one, or a clear that
  // failed.
  if (gate.outcome === "sent") {
    await deps.clear().catch((error: unknown) =>
      console.error(`First prompt: couldn't clear the one kept for ${label}`, error),
    );
    return;
  }
  // The page's own copy is still going: it marks and clears. Left alone, so
  // a failure of it can still be retried.
  if (gate.outcome !== "send") return;
  let prompt = stored.prompt;
  try {
    prompt = await deps.attach(stored.prompt, stored.attachmentIds);
  } catch (error) {
    console.error(`First prompt: attachments failed for ${label}`, error);
    await gate.release();
    return;
  }
  // Claimed over while the files were written: that sender delivers it, and
  // clears the kept copy with its own marking.
  if (!(await gate.held())) return;
  try {
    await deps.send(prompt);
  } catch (error) {
    // Released, so the page's copy (or a later delivery) still can; the
    // kept one waits for them.
    console.error(`First prompt: couldn't deliver the one kept for ${label}`, error);
    await gate.release();
    return;
  }
  await gate.sent();
  await deps.clear().catch((error: unknown) =>
    console.error(`First prompt: couldn't clear the one kept for ${label}`, error),
  );
  await deps.watch().catch((error: unknown) =>
    console.error(`First prompt: couldn't watch ${label} after delivering its kept prompt`, error),
  );
}
