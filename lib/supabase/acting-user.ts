/**
 * Acting as a user without their browser: for work the server starts on its
 * own on someone's behalf (an automation, from a signed GitHub webhook), which
 * the user's session path must run exactly as when they start it themselves.
 *
 * That path reads and writes through the user's own Supabase client, cookie
 * bound, under RLS and database functions that ask auth.uid() (a box's claim
 * counts their plan's boxes): the service role can't stand in for it. So this
 * signs in as the user for the length of `work`, with a one-time login token
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
  const client = createClient<Database>(url, requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { auth: noSession });
  const { data: verified, error: verifyError } = await client.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "email",
  });
  if (verifyError || verified.user?.id !== userId) {
    throw new ActAsUserError(`Couldn't sign in as that user: ${verifyError?.message ?? "another user"}`);
  }

  try {
    return await acting.run({ userId, client }, work);
  } finally {
    await client.auth.signOut({ scope: "local" }).catch((error: unknown) => {
      console.warn("Couldn't sign out the session acted as", error);
    });
  }
}
