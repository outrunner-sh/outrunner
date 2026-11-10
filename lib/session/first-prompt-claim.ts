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
export type FirstPromptClaim =
  /** This request holds it, as of `claimedAt`: its claim's own token. */
  | { state: "claimed"; claimedAt: string }
  | { state: "sent" | "sending" | "other" };

/** Each of sent, release and renew acts only on the claim `claimedAt` names,
 *  so a request whose claim was taken over can't touch the new holder's. */
export type FirstPromptClaimDeps = {
  claim: (key: string) => Promise<FirstPromptClaim>;
  /** The claim's new token, or null when it is no longer this one. */
  renew: (key: string, claimedAt: string) => Promise<string | null>;
  sent: (key: string, claimedAt: string) => Promise<void>;
  release: (key: string, claimedAt: string) => Promise<void>;
};

/**
 * What a send does about its key: "send" goes (and says how it ended, through
 * `sent` or `release`); "sent" is a repeat of one that went, answered as sent;
 * "sending" a repeat while its send is still going, to try again shortly.
 * `held`, just before the prompt goes to the box, renews the claim, and is
 * false when another request took it over meanwhile (this one ran so long its
 * claim counted as abandoned): that one sends it, so this one mustn't.
 */
export type FirstPromptGate = {
  outcome: "send" | "sent" | "sending";
  held: () => Promise<boolean>;
  sent: () => Promise<void>;
  release: () => Promise<void>;
};

/**
 * How long a claim may go unrenewed before it is taken as abandoned (its
 * server stopped mid-send) and a repeat sends it again. Renewed just before
 * the prompt goes to the box, so it need only outlast the agent's own send
 * timeout (lib/runtime/agent-client.ts), with room to spare.
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
const yes = async () => true;
const UNGUARDED: FirstPromptGate = { outcome: "send", held: yes, sent: nothing, release: nothing };

/**
 * Claim the first prompt for `key` before it is sent. Another key holding it
 * (a prompt sent from a copy the browser lost track of) is not one this key
 * can speak for, so it goes as an ordinary message would. No key, or a
 * database without the columns yet, sends as before: unguarded, never refused.
 *
 * `strict` (for a sender that isn't waiting on its own send — setup
 * delivering the kept copy, lib/session/deliver-first-prompt.ts) refuses
 * that fallback instead: a claim that can't be made throws, and the caller
 * stands down rather than send unguarded — a send nothing recorded would let
 * the session page's own clean claim send again, twice over.
 */
export async function gateFirstPrompt(
  key: string | null,
  deps: FirstPromptClaimDeps,
  label: string,
  { strict = false }: { strict?: boolean } = {},
): Promise<FirstPromptGate> {
  if (!key) return UNGUARDED;
  let claim: FirstPromptClaim;
  try {
    claim = await deps.claim(key);
  } catch (error) {
    if (strict) throw error;
    console.error(`Message: could not claim the first prompt of ${label}; sending it unguarded`, error);
    return UNGUARDED;
  }
  if (claim.state !== "claimed") {
    return claim.state === "other" ? UNGUARDED : { outcome: claim.state, held: yes, sent: nothing, release: nothing };
  }
  let claimedAt = claim.claimedAt;
  return {
    outcome: "send",
    held: async () => {
      try {
        const renewed = await deps.renew(key, claimedAt);
        if (!renewed) return false;
        claimedAt = renewed;
        return true;
      } catch (error) {
        // Unrenewed, a repeat may take it over only once it counts as
        // abandoned, by when this send has long timed out.
        console.error(`Message: could not renew the first prompt of ${label}`, error);
        return true;
      }
    },
    sent: async () => {
      try {
        await deps.sent(key, claimedAt);
      } catch (error) {
        // Unmarked, a repeat is told to wait until the claim is abandoned,
        // then sends it again: logged, as that is the one way it goes twice.
        console.error(`Message: could not mark the first prompt of ${label} sent`, error);
      }
    },
    release: async () => {
      try {
        await deps.release(key, claimedAt);
      } catch (error) {
        // Held, a repeat waits until the claim is abandoned, then sends.
        console.error(`Message: could not release the first prompt of ${label}`, error);
      }
    },
  };
}
