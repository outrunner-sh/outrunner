/**
 * A session's first prompt goes to Claude once per idempotency key, on the
 * server: the browser's own guards (lib/session/first-prompt.ts) keep a tab
 * from sending it twice, but not a reload racing a send still going, nor Send
 * it again pressed before the conversation shows the prompt, nor a tab whose
 * storage is blocked. Each of those sends names the key the new-session screen
 * made with the prompt, and the message route claims the session's first
 * prompt for it before sending. A repeat finds it claimed and answers as sent.
 *
 * Only the first prompt carries a key; any other message is sent as it comes.
 */
export type FirstPromptClaim = "claimed" | "repeat" | "other";

export type FirstPromptClaimDeps = {
  claim: (key: string) => Promise<FirstPromptClaim>;
  release: (key: string) => Promise<void>;
};

/** What a send does about its key: skip as a repeat, or go, and on failing
 *  `release` the claim so a retry with the key still sends. */
export type FirstPromptGate = { repeat: boolean; release: () => Promise<void> };

const KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** The request's first-prompt key, if it names a usable one (the browser's
 *  is a uuid); anything else is sent as an ordinary message. */
export function firstPromptKey(value: unknown): string | null {
  return typeof value === "string" && KEY_RE.test(value) ? value : null;
}

const NO_CLAIM: FirstPromptGate = { repeat: false, release: async () => {} };

/**
 * Claim the first prompt for `key` before it is sent. A repeat of the key is
 * skipped. Another key holding it (a prompt sent from a copy the browser lost
 * track of) is not one this key can speak for, so it goes as an ordinary
 * message would. No key, or a database without the column yet, sends as
 * before: unguarded, never refused.
 */
export async function gateFirstPrompt(
  key: string | null,
  deps: FirstPromptClaimDeps,
  label: string,
): Promise<FirstPromptGate> {
  if (!key) return NO_CLAIM;
  let claim: FirstPromptClaim;
  try {
    claim = await deps.claim(key);
  } catch (error) {
    console.error(`Message: could not claim the first prompt of ${label}; sending it unguarded`, error);
    return NO_CLAIM;
  }
  if (claim === "repeat") return { repeat: true, release: async () => {} };
  if (claim === "other") return NO_CLAIM;
  return {
    repeat: false,
    release: async () => {
      try {
        await deps.release(key);
      } catch (error) {
        // Held, a retry with this key is skipped as sent: logged, as it can
        // only cost the prompt, never send it twice.
        console.error(`Message: could not release the first prompt of ${label}`, error);
      }
    },
  };
}
