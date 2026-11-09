/**
 * An installation's access token, kept fresh. Both trackers rotate refresh
 * tokens, so two refreshes at once would leave one holding a dead token and the
 * install disconnected: one caller at a time holds a lease on the row
 * (refreshing_until, taken in one conditional update, as claimDigest takes a
 * digest), since a transaction can't stay open across the provider's HTTP call.
 *
 * The tick refreshes ahead of time, while the current token still works, so a
 * request almost never waits. One that finds the token really expired waits at
 * most {@link WAIT_MS}, then gives up with {@link TokenUnavailableError}: a
 * webhook answers 503 for it, so the tracker delivers again.
 *
 * Only the tracker refusing a refresh (invalid_grant) disconnects an install. A
 * 401 on a call doesn't: the tick may have just rotated the token the call read.
 *
 * Authorizing again (an admin reconnecting, another org connecting a shared
 * workspace) replaces the tokens while a call or a refresh may be in flight. So
 * what a refresh stores, and what a refused one disconnects, only takes while the
 * row still holds the refresh token it used; otherwise the new tokens stand.
 */

import { TrackerRevokedError, type TrackerTokens, TrackerUnauthorizedError, TrackerUnavailableError } from "@/lib/trackers/errors";
import type { TrackerProvider } from "@/lib/trackers/rules";

/** How long a refresh is held for. Past it, a refresh that died is taken over;
 *  the tracker's own window for reusing an old refresh token covers one that
 *  died after the tracker rotated it (Linear's 30 minutes). On a real workspace,
 *  reusing one seconds later gave back the same pair, and nothing was killed. */
export const LEASE_MS = 30_000;
/** Refresh once less than this is left of the token. Linear's last 24h, and Jira's 1h,
 *  and the tick runs every 2 minutes. */
export const REFRESH_MARGIN_MS: Record<TrackerProvider, number> = { linear: 2 * 60 * 60 * 1000, jira: 20 * 60 * 1000 };
/** How long a request waits for someone else's refresh. */
export const WAIT_MS = 3000;
const POLL_MS = 250;
/** A token this close to its end isn't handed out. */
const USABLE_MARGIN_MS = 30_000;
/** Far enough ahead that any token counts as due: a refresh forced by a 401. */
const FORCE_MS = 400 * 24 * 60 * 60 * 1000;

/** No token right now; worth trying again soon. */
export class TokenUnavailableError extends Error {}
/** The install has no token and won't get one: it needs reconnecting. */
export class TrackerDisconnectedError extends Error {}

/** A row, with its tokens opened. */
export type TokenRow = {
  id: string;
  provider: TrackerProvider;
  accessToken: string | null;
  refreshToken: string | null;
  /** Which refresh token this is, as stored: what store and disconnect check is
   *  still there. Null with none. */
  version: string | null;
  expiresAt: number | null;
  disconnected: boolean;
};

export type TokenDeps = {
  load(id: string): Promise<TokenRow | null>;
  /** Take the lease if the token is due and no one holds it; the row as it
   *  stands if taken. */
  claim(id: string, opts: { now: number; leaseUntil: number; dueBefore: number }): Promise<TokenRow | null>;
  /** Keep what the refresh gave, and let the lease go, if the row still holds
   *  `version`. Whether it did. */
  store(id: string, tokens: TrackerTokens, version: string | null): Promise<boolean>;
  release(id: string): Promise<void>;
  /** Disconnect, if the row still holds `version`. Whether it did. */
  disconnect(id: string, version: string | null): Promise<boolean>;
  refresh(refreshToken: string, provider: TrackerProvider): Promise<TrackerTokens>;
  now(): number;
  sleep(ms: number): Promise<void>;
};

/** Refresh a row whose lease we hold. */
async function refreshHeld(row: TokenRow, deps: TokenDeps): Promise<string> {
  if (!row.refreshToken) {
    if (await deps.disconnect(row.id, row.version)) throw new TrackerDisconnectedError("No refresh token.");
    return replacedToken(row.id, deps);
  }
  let tokens: TrackerTokens;
  try {
    tokens = await deps.refresh(row.refreshToken, row.provider);
  } catch (error) {
    if (error instanceof TrackerRevokedError) {
      if (await deps.disconnect(row.id, row.version)) throw new TrackerDisconnectedError("The tracker refused the refresh.");
      return replacedToken(row.id, deps);
    }
    // Worth another go: let the next caller try at once, not after the lease.
    await deps.release(row.id).catch(() => undefined);
    throw error;
  }
  return (await deps.store(row.id, tokens, row.version)) ? tokens.accessToken : replacedToken(row.id, deps);
}

/** Someone authorized again while we refreshed: what they saved stands. */
async function replacedToken(id: string, deps: TokenDeps): Promise<string> {
  const row = await deps.load(id);
  if (!row || row.disconnected || !row.accessToken) throw new TrackerDisconnectedError("Not connected.");
  return row.accessToken;
}

function usable(row: TokenRow, now: number): string | null {
  return row.accessToken && row.expiresAt !== null && row.expiresAt > now + USABLE_MARGIN_MS ? row.accessToken : null;
}

/** Refresh, or wait a short while for whoever is. `refused` is a token the
 *  tracker turned down: not one to come back with, and it forces the refresh
 *  however long it had left. */
async function refreshOrWait(id: string, provider: TrackerProvider, deps: TokenDeps, refused: string | null): Promise<string> {
  const deadline = deps.now() + WAIT_MS;
  for (;;) {
    const now = deps.now();
    const held = await deps.claim(id, { now, leaseUntil: now + LEASE_MS, dueBefore: now + (refused ? FORCE_MS : REFRESH_MARGIN_MS[provider]) });
    if (held) {
      // Someone finished between our read and our claim: no need for another.
      const fresh = usable(held, now);
      if (refused && fresh && fresh !== refused) {
        await deps.release(id);
        return fresh;
      }
      return refreshHeld(held, deps);
    }
    const current = await deps.load(id);
    if (!current || current.disconnected) throw new TrackerDisconnectedError("Not connected.");
    const token = usable(current, deps.now());
    if (token && token !== refused) return token;
    if (deps.now() >= deadline) throw new TokenUnavailableError("Someone else's refresh is taking too long.");
    await deps.sleep(POLL_MS);
  }
}

/**
 * The token to call the tracker with. Only a token that has really expired
 * waits on anything: while it works, a refresh going on elsewhere is no reason
 * to, and the caller may have a deadline of seconds (a webhook's answer).
 */
export async function accessToken(id: string, deps: TokenDeps): Promise<string> {
  const row = await deps.load(id);
  if (!row || row.disconnected || !row.accessToken) throw new TrackerDisconnectedError("Not connected.");
  return usable(row, deps.now()) ?? refreshOrWait(id, row.provider, deps, null);
}

/**
 * The tracker answered a call with 401: a token other than `refused` if the
 * tick has already rotated it, otherwise a refresh, however long the token had
 * left. If the install was really revoked, the refresh is what finds out.
 */
export async function tokenAfterRefusal(id: string, refused: string, deps: TokenDeps): Promise<string> {
  const row = await deps.load(id);
  if (!row || row.disconnected || !row.accessToken) throw new TrackerDisconnectedError("Not connected.");
  const token = usable(row, deps.now());
  return token && token !== refused ? token : refreshOrWait(id, row.provider, deps, refused);
}

/**
 * Ask the tracker something with the install's token, retrying once on a 401
 * with a newer one. A disconnected install answers `fallback`: there's nothing
 * to retry. A second 401 doesn't disconnect it (only a refused refresh does): it
 * throws, for the caller to try again later.
 */
export async function withToken<T, F>(id: string, fallback: F, question: (token: string) => Promise<T>, deps: TokenDeps): Promise<T | F> {
  try {
    const token = await accessToken(id, deps);
    try {
      return await question(token);
    } catch (error) {
      if (!(error instanceof TrackerUnauthorizedError)) throw error;
      return await question(await tokenAfterRefusal(id, token, deps));
    }
  } catch (error) {
    if (error instanceof TrackerDisconnectedError) return fallback;
    if (error instanceof TrackerUnauthorizedError) throw new TrackerUnavailableError("The tracker refused a fresh token.");
    throw error;
  }
}

/** The tick: refresh one install if it's due and no one else is. Whether it did. */
export async function refreshIfDue(id: string, provider: TrackerProvider, deps: TokenDeps): Promise<boolean> {
  const now = deps.now();
  const held = await deps.claim(id, { now, leaseUntil: now + LEASE_MS, dueBefore: now + REFRESH_MARGIN_MS[provider] });
  if (!held) return false;
  await refreshHeld(held, deps);
  return true;
}
