/**
 * A session's first prompt goes to Claude once per idempotency key, on the
 * server: the browser's own guards (lib/session/first-prompt.ts) keep a tab
 * from sending it twice, but not a reload racing a send still going, nor Send
 * it again pressed before the conversation shows the prompt, nor a tab whose
 * storage is blocked. Each of those sends names the key the new-session screen
 * made with the prompt, and the message route claims the session's first
 * prompt for it before sending, then marks it sent once the box has it. A
 * repeat of a sent one answers as sent; one while the claim's send is still
 * going is told to try again, so a send that then fails can't leave a page
 * believing its prompt went.
 *
 * Only the first prompt carries a key; any other message is sent as it comes.
 */
export type FirstPromptClaim = "claimed" | "sent" | "sending" | "other";

export type FirstPromptClaimDeps = {
  claim: (key: string) => Promise<FirstPromptClaim>;
  sent: (key: string) => Promise<void>;
  release: (key: string) => Promise<void>;
};

/**
 * What a send does about its key: "send" goes (and says how it ended, through
 * `sent` or `release`); "sent" is a repeat of one that went, answered as sent;
 * "sending" a repeat while its send is still going, to try again shortly.
 */
export type FirstPromptGate = {
  outcome: "send" | "sent" | "sending";
  sent: () => Promise<void>;
  release: () => Promise<void>;
};

/**
 * How long a claim's send may take before the claim is taken as abandoned (its
 * server stopped mid-send) and a repeat sends it again: well past attaching
 * files and the agent's own send timeout (lib/runtime/agent-client.ts).
 */
export const FIRST_PROMPT_SENDING_MS = 120_000;

/** Claims made before this (an ISO time) whose send never finished are abandoned. */
export function abandonedBefore(now: Date): string {
  return new Date(now.getTime() - FIRST_PROMPT_SENDING_MS).toISOString();
}

const KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** The request's first-prompt key, if it names a usable one (the browser's
 *  is a uuid); anything else is sent as an ordinary message. */
export function firstPromptKey(value: unknown): string | null {
  return typeof value === "string" && KEY_RE.test(value) ? value : null;
}

const nothing = async () => {};
const UNGUARDED: FirstPromptGate = { outcome: "send", sent: nothing, release: nothing };

/**
 * Claim the first prompt for `key` before it is sent. Another key holding it
 * (a prompt sent from a copy the browser lost track of) is not one this key
 * can speak for, so it goes as an ordinary message would. No key, or a
 * database without the columns yet, sends as before: unguarded, never refused.
 */
export async function gateFirstPrompt(
  key: string | null,
  deps: FirstPromptClaimDeps,
  label: string,
): Promise<FirstPromptGate> {
  if (!key) return UNGUARDED;
  let claim: FirstPromptClaim;
  try {
    claim = await deps.claim(key);
  } catch (error) {
    console.error(`Message: could not claim the first prompt of ${label}; sending it unguarded`, error);
    return UNGUARDED;
  }
  if (claim === "sent" || claim === "sending") return { outcome: claim, sent: nothing, release: nothing };
  if (claim === "other") return UNGUARDED;
  return {
    outcome: "send",
    sent: async () => {
      try {
        await deps.sent(key);
      } catch (error) {
        // Unmarked, a repeat is told to wait until the claim is abandoned,
        // then sends it again: logged, as that is the one way it goes twice.
        console.error(`Message: could not mark the first prompt of ${label} sent`, error);
      }
    },
    release: async () => {
      try {
        await deps.release(key);
      } catch (error) {
        // Held, a repeat waits until the claim is abandoned, then sends.
        console.error(`Message: could not release the first prompt of ${label}`, error);
      }
    },
  };
}
