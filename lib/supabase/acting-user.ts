/**
 * Acting as a user without their browser: for work the server starts on its
 * own on someone's behalf (an automation, from a signed GitHub webhook), which
 * the user's session path must run exactly as when they start it themselves.
 *
 * That path reads through the user's own Supabase client, cookie bound,
 * under RLS, and asks Supabase Auth who is signed in (a box's claim counts
 * that user's boxes, lib/db/repositories.ts claimingUserId): the service role
 * can't stand in for it. (The tables' own writes, and the box claims since
 * 20261112120000, are the server's alone — 20261106100000 — and go through
 * the admin client whatever session is acting.) So this signs in as the user for
 * the length of `work`, with a one-time login token
 * the admin API mints (never emailed), and createSupabaseServerClient()
 * answers with that client inside it. The session is signed out after.
 *
 * Only for a user id the server itself trusts (an automation's runner), never
 * one a request names.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requireEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

const acting = new AsyncLocalStorage<{ userId: string; client: SupabaseClient<Database> }>();

/** The client of the user being acted as, inside actAsUser; else undefined. */
export function actingUserClient(): SupabaseClient<Database> | undefined {
  return acting.getStore()?.client;
}

/** Thrown when a user can't be acted as: gone, or without an email to sign in by. */
export class ActAsUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActAsUserError";
  }
}

/** Run `work` signed in as `userId`; their session ends when it does. */
export async function actAsUser<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const client = await signInAs(userId);
  try {
    return await acting.run({ userId, client }, work);
  } finally {
    await signOutOf(client);
  }
}

/**
 * A client signed in as `userId`, with a one-time login token the admin API
 * mints (never emailed). Refreshed while it's in use: work that outlasts one
 * access token (an hour) would otherwise fail its last writes. Off the
 * browser, auth-js starts that refresh as the client is made, so a failed
 * sign-in is signed out here before it throws.
 */
async function signInAs(userId: string): Promise<SupabaseClient<Database>> {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
  // The service role, made here rather than taken from lib/supabase/server,
  // which imports this module.
  const admin = createClient<Database>(url, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: noSession }).auth.admin;
  const { data: found, error: findError } = await admin.getUserById(userId);
  if (findError || !found.user) throw new ActAsUserError("That user is gone.");
  const email = found.user.email;
  if (!email) throw new ActAsUserError("That user has no email to sign in with.");

  const { data: link, error: linkError } = await admin.generateLink({ type: "magiclink", email });
  if (linkError || !link.properties?.hashed_token) {
    throw new ActAsUserError(`Couldn't sign in as that user: ${linkError?.message ?? "no token"}`);
  }
  const client = createClient<Database>(url, requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { ...noSession, autoRefreshToken: true },
  });
  try {
    const { data: verified, error: verifyError } = await client.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "email",
    });
    if (verifyError || verified.user?.id !== userId) {
      throw new ActAsUserError(`Couldn't sign in as that user: ${verifyError?.message ?? "another user"}`);
    }
    return client;
  } catch (error) {
    await signOutOf(client);
    throw error;
  }
}

async function signOutOf(client: SupabaseClient<Database>): Promise<void> {
  await client.auth.stopAutoRefresh();
  await client.auth.signOut({ scope: "local" }).catch((error: unknown) => {
    console.warn("Couldn't sign out the session acted as", error);
  });
}

/**
 * Kept sign-ins, for the API (lib/api/handler.ts): a script polling a
 * session makes a call every few seconds, and signing in afresh for each
 * would spend Supabase's verifications, which it limits per server address
 * (a few hundred an hour). One client per user is kept while it's used, and
 * signed out once it has sat unused for KEPT_IDLE_MS with no work holding it.
 */
const KEPT_IDLE_MS = 15 * 60_000;
/** Users kept at once; past it, the longest unused (and unheld) goes. */
const KEPT_MAX = 200;

type Kept = {
  client: Promise<SupabaseClient<Database>>;
  lastUsed: number;
  /** Work still running on it (a session's setup after its response). */
  holds: number;
};

const kept = new Map<string, Kept>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function keptFor(userId: string): Kept {
  let entry = kept.get(userId);
  if (!entry) {
    // Room made before it's kept, so the new sign-in is never the one let go.
    trimKept(KEPT_MAX - 1);
    const client = signInAs(userId);
    entry = { client, lastUsed: Date.now(), holds: 0 };
    kept.set(userId, entry);
    // A sign-in that failed isn't kept: the next call tries again.
    client.catch(() => {
      if (kept.get(userId) === entry) kept.delete(userId);
    });
    if (!sweeper) {
      sweeper = setInterval(sweepKept, 60_000);
      sweeper.unref?.();
    }
  }
  entry.lastUsed = Date.now();
  return entry;
}

function release(userId: string, entry: Kept): void {
  if (kept.get(userId) !== entry) return;
  kept.delete(userId);
  void entry.client.then(signOutOf, () => undefined);
}

function sweepKept(now = Date.now()): void {
  for (const [userId, entry] of kept) {
    if (entry.holds === 0 && now - entry.lastUsed > KEPT_IDLE_MS) release(userId, entry);
  }
}

/** Let go of the longest unused (and unheld) sign-ins, down to `max`. */
function trimKept(max: number): void {
  if (kept.size <= max) return;
  const idle = [...kept].filter(([, e]) => e.holds === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [userId, entry] of idle.slice(0, kept.size - max)) release(userId, entry);
}

/**
 * Run `work` signed in as `userId`, on a sign-in kept for their next call
 * (see KEPT_IDLE_MS) rather than one made and ended for this one. Only for a
 * user id the server has checked (an API key's maker).
 */
export async function actAsUserKept<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const entry = keptFor(userId);
  // Held before the sign-in is awaited: while it's in flight, a trim made
  // room for another user would otherwise take this one, and sign it out
  // under the work about to run on it.
  entry.holds++;
  try {
    const client = await entry.client;
    return await acting.run({ userId, client }, work);
  } finally {
    entry.holds--;
    entry.lastUsed = Date.now();
  }
}

/**
 * Keep the user's kept sign-in from being signed out until the returned
 * function is called: for work that goes on after the call that started it
 * (a session's setup, in after()). Inside actAsUserKept.
 */
export function holdActingUser(): () => void {
  const userId = acting.getStore()?.userId;
  const entry = userId ? kept.get(userId) : undefined;
  if (!entry) return () => undefined;
  entry.holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.holds--;
    entry.lastUsed = Date.now();
  };
}
