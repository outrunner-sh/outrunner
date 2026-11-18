/**
 * The session cookie's name, pinned. @supabase/ssr names it after the
 * project (`sb-<ref>-auth-token`), so moving the database to another project
 * (Tokyo to Mumbai, 2026-11) would have signed everyone out. Keeping the
 * first project's name lets the new one refresh the sessions it was given in
 * the move. Every Supabase client that reads the session must use it.
 */
export const SESSION_COOKIE_OPTIONS = { name: "sb-butbnitdpiehgwqggowr-auth-token" } as const;
