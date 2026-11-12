/**
 * Record the provider of each Runtime Computer whose row doesn't say
 * (lib/runtime/unrecorded-computers.ts), by asking Daytona and Neev which has
 * its box. Run before changing RUNTIME_PROVIDER (docs/deploy-cloudflare.md).
 * Prints what it finds; writes only with --apply, and only rows exactly one
 * provider has. A box neither has is gone, so its row's provider doesn't
 * matter; one both claim is printed for an operator.
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

async function has(get: () => Promise<unknown>, notFound: (error: unknown) => boolean): Promise<boolean> {
  try {
    await get();
    return true;
  } catch (error) {
    if (notFound(error)) return false;
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
for (const row of rows) {
  const box = row.daytona_sandbox_id as string;
  const found: Record<string, boolean> = {};
  if (daytona) found.daytona = await has(() => daytona.get(box), (e) => e instanceof DaytonaNotFoundError);
  if (neev) found.neev = await has(() => neev.sandboxes.get(box), (e) => e instanceof NotFoundError);
  const provider = providerOfBox(found);
  console.log(`${row.id} (${row.status}) box ${box}: ${JSON.stringify(found)} -> ${provider ?? "left as is"}`);
  if (!apply || !provider || !daytona || !neev) continue;
  const { error: writeError } = await db
    .from("runtime_computers")
    .update({ provider })
    .eq("id", row.id)
    .is("provider", null);
  if (writeError) throw writeError;
  written += 1;
}
console.log(apply ? `${written} row(s) written` : "Dry run: --apply to write");
