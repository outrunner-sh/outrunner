import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { requireEnv } from "@/lib/env";
import { timeoutSignal } from "@/lib/http/timeout";
import { actingUserClient } from "@/lib/supabase/acting-user";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Supabase client for Server Components, Route Handlers, and Server Actions.
 *
 * A fresh client per request — never share one across requests. Cookie access
 * uses getAll/setAll only; the get/set/remove trio is deprecated and causes
 * silent session loss.
 */
export async function createSupabaseServerClient() {
  // Inside actAsUser (lib/supabase/acting-user.ts): that user's client, as if
  // their browser had asked.
  const acting = actingUserClient();
  if (acting) return acting;
  const cookieStore = await cookies();

  return createServerClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. The proxy refreshes the
            // session instead, so this is safe to swallow.
          }
        },
      },
    },
  );
}

/**
 * Service-role client: bypasses RLS. Use only for trusted server-side work
 * that acts on the owner's behalf (background job state transitions, log
 * offset bookkeeping) and never in response to unauthenticated input.
 */
export function createSupabaseAdminClient() {
  return createServerClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      cookies: { getAll: () => [], setAll: () => {} },
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: adminFetch },
    },
  );
}

/** How long the service-role client waits on Supabase: a query, or a
 *  Storage transfer (a snapshot up or down), before it gives up. Without a
 *  limit, a hung connection held a request, an after() or a cron tick for
 *  good. */
const ADMIN_QUERY_TIMEOUT_MS = 30_000;
const ADMIN_STORAGE_TIMEOUT_MS = 120_000;

/** fetch, with the limit above, kept alongside the caller's own signal. */
export const adminFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const ms = url.includes("/storage/v1/") ? ADMIN_STORAGE_TIMEOUT_MS : ADMIN_QUERY_TIMEOUT_MS;
  return fetch(input, { ...init, signal: timeoutSignal(ms, init?.signal) });
};
