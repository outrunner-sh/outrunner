/**
 * Recalling the prompts a user has sent, as a shell recalls commands: ↑ in an
 * empty composer steps back through them, newest first, ↓ steps forward again
 * and past the newest gives the box back as it was; Ctrl+R searches them. The
 * history is the user's, across sessions (prompt_history, through
 * /api/prompt-history); this module is its logic, without React or storage.
 */

/** How many prompts recall offers: plenty to search, little to send. */
export const HISTORY_LIMIT = 200;

/** The longest prompt kept: the table's limit. */
const MAX_PROMPT = 20_000;

/** A prompt as history keeps it (trimmed), or null for one not worth keeping:
 *  empty, too long, or a command of the composer's own (/compact). */
export function recallable(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_PROMPT || /^\/compact\b/.test(trimmed)) return null;
  return trimmed;
}

/** Prompts newest first, each once (where it was sent last). */
export function newestDistinct(prompts: string[]): string[] {
  const seen = new Set<string>();
  return prompts.filter((p) => !seen.has(p) && seen.add(p));
}

/** The history with `text` just sent: first, and nowhere else. */
export function withPrompt(history: string[], text: string): string[] {
  const kept = recallable(text);
  return kept ? newestDistinct([kept, ...history]).slice(0, HISTORY_LIMIT) : history;
}

/** Where ↑/↓ have got to: the prompt shown (`index` into the history), and
 *  what was in the box before recall began, to give back past the newest. */
export type Recall = { index: number; draft: string };

/**
 * One step of recall: "older" (↑) or "newer" (↓) from where it is (null: not
 * recalling, the box holding `draft`). Returns the box's new value and where
 * recall is, or null where there's nowhere to go (nothing older; not recalling
 * and asked for newer), so the key does what it otherwise would.
 */
export function recallStep(
  history: string[],
  recall: Recall | null,
  direction: "older" | "newer",
  draft: string,
): { value: string; recall: Recall | null } | null {
  if (direction === "older") {
    const index = recall ? recall.index + 1 : 0;
    if (index >= history.length) return null;
    return { value: history[index], recall: { index, draft: recall?.draft ?? draft } };
  }
  if (!recall) return null;
  if (recall.index === 0) return { value: recall.draft, recall: null };
  return { value: history[recall.index - 1], recall: { ...recall, index: recall.index - 1 } };
}

/** The prompts holding every word of `query`, any case, newest first; all of
 *  them for an empty query. */
export function searchHistory(history: string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return history;
  return history.filter((p) => {
    const lower = p.toLowerCase();
    return words.every((w) => lower.includes(w));
  });
}
