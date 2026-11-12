/**
 * Runtime Computers whose row doesn't say which provider made their box
 * (`runtime_computers.provider` null: made before it was recorded, in
 * October 2026). Code reads such a row as the deployment's provider's
 * (computerMadeBy), which is wrong once the deployment moves to another: a
 * box on the old one is asked of the new, read as gone, and left running
 * unmetered. Production ran Neev, then Daytona, before it was recorded, so no
 * one provider can be assumed for them: scripts/assign-computer-providers.ts
 * asks each which has the box. /api/health counts them, for the cutover's
 * check (docs/deploy-cloudflare.md).
 */

/** How many rows naming a box don't record its provider, or "unreachable". */
export async function countUnrecordedComputers(): Promise<number | "unreachable"> {
  try {
    // Imported here: the server client needs Next's runtime, which the
    // script and the tests of providerOfBox don't have.
    const { createSupabaseAdminClient } = await import("@/lib/supabase/server");
    const { count, error } = await createSupabaseAdminClient()
      .from("runtime_computers")
      .select("id", { count: "exact", head: true })
      .is("provider", null)
      .not("daytona_sandbox_id", "is", null);
    if (error) return "unreachable";
    return count ?? 0;
  } catch {
    return "unreachable";
  }
}

/** Which provider a box is on, by which of them has it: the one, or null
 *  when none or both say so (left for an operator). */
export function providerOfBox(found: Record<string, boolean>): string | null {
  const having = Object.entries(found).filter(([, has]) => has).map(([name]) => name);
  return having.length === 1 ? having[0] : null;
}
