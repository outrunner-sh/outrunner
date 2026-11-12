/**
 * Record the provider of each Runtime Computer whose row doesn't say
 * (lib/runtime/unrecorded-computers.ts), by asking Daytona and Neev which has
 * its box. Run before changing RUNTIME_PROVIDER (docs/deploy-cloudflare.md).
 * Prints what it finds; writes only with --apply (and both providers' keys).
 * The rules are providerOfBox's: a row exactly one provider has gets that
 * one; a row whose box both say a real not-found for gets "daytona" (gone),
 * so /api/health's count can reach 0. A box both claim, one a provider only
 * refused the id of, or one a lookup failed for, is left as is and printed
 * for an operator (run it again; the rest is unaffected).
 *
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs scripts/assign-computer-providers.ts [--apply]
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DAYTONA_API_KEY and
 * NEEV_API_KEY / NEEV_ORG_ID / NEEV_PROJECT_ID (a provider whose keys are
 * missing is skipped, and nothing is written).
 */

import { Daytona, DaytonaNotFoundError } from "@daytonaio/sdk";
import { Neev, NotFoundError } from "@neevcloud/sdk";
import { createClient } from "@supabase/supabase-js";

const { providerOfBox } = await import("@/lib/runtime/unrecorded-computers");
type BoxAnswer = import("@/lib/runtime/unrecorded-computers").BoxAnswer;

const apply = process.argv.includes("--apply");
const daytona = process.env.DAYTONA_API_KEY
  ? new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL || undefined })
  : null;
const neev =
  process.env.NEEV_API_KEY && process.env.NEEV_ORG_ID && process.env.NEEV_PROJECT_ID
    ? new Neev({
        apiKey: process.env.NEEV_API_KEY,
        orgId: process.env.NEEV_ORG_ID,
        projectId: process.env.NEEV_PROJECT_ID,
        baseURL: process.env.NEEV_BASE_URL || undefined,
      })
    : null;

/** What a provider says about a box: it has it, a real not-found, or a
 *  refusal of the id (400/422, as asking one provider about the other's id
 *  may get). Anything else throws. */
async function ask(get: () => Promise<unknown>, notFound: (error: unknown) => boolean): Promise<BoxAnswer> {
  try {
    await get();
    return "yes";
  } catch (error) {
    if (notFound(error)) return "no";
    const { status, statusCode } = (error ?? {}) as { status?: unknown; statusCode?: unknown };
    if ([400, 422].includes(Number(status ?? statusCode))) return "refused";
    throw error;
  }
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const { data: rows, error } = await db
  .from("runtime_computers")
  .select("id, status, daytona_sandbox_id")
  .is("provider", null)
  .not("daytona_sandbox_id", "is", null);
if (error) throw error;
console.log(`${rows.length} row(s) naming a box with no provider recorded`);
if (!daytona || !neev) console.log(`Missing ${!daytona ? "Daytona" : "Neev"} keys: reporting only, nothing is written.`);

let written = 0;
let unresolved = 0;
for (const row of rows) {
  const box = row.daytona_sandbox_id as string;
  const answers: Record<string, BoxAnswer> = {};
  try {
    if (daytona) answers.daytona = await ask(() => daytona.get(box), (e) => e instanceof DaytonaNotFoundError);
    if (neev) answers.neev = await ask(() => neev.sandboxes.get(box), (e) => e instanceof NotFoundError);
  } catch (lookupError) {
    // A rate limit, a network blip, an auth error: this row only.
    console.error(`${row.id} (${row.status}) box ${box}: lookup failed, left as is`, lookupError);
    unresolved += 1;
    continue;
  }
  // Gone only once both were asked and both said a real not-found.
  const provider = providerOfBox(answers, daytona !== null && neev !== null);
  if (!provider) unresolved += 1;
  console.log(`${row.id} (${row.status}) box ${box}: ${JSON.stringify(answers)} -> ${provider ?? "left as is: an operator decides"}`);
  if (!apply || !provider || !daytona || !neev) continue;
  const { error: writeError } = await db
    .from("runtime_computers")
    .update({ provider })
    .eq("id", row.id)
    .is("provider", null);
  if (writeError) throw writeError;
  written += 1;
}
console.log(`${apply ? `${written} row(s) written` : "Dry run: --apply to write"}; ${unresolved} left for an operator`);
