/**
 * The masked tail the Claude settings UI shows, derived from the stored hint.
 *
 * Its own module with no imports, for the same reason `anthropic-env.ts` is:
 * the credential adapter next door reaches the database, which pulls
 * `next/headers` in through the Supabase server client, and the unit-test
 * loader cannot resolve that. A pure decision worth pinning in tests should not
 * be reachable only through a module that needs a Next request context.
 */
export function last4FromHint(hint: string | null): string | null {
  if (!hint) return null;
  const tail = hint.slice(-4);
  return tail.length === 4 ? tail : null;
}
