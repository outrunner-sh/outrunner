import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { selectCodexAccount } from "@/lib/codex/access";
import { z } from "zod";
import { open, seal } from "@/lib/crypto/secret-box";
import { memberRole } from "@/lib/db/orgs";
import { revoked, type Connection } from "@/lib/codex/account";
import { codexStore } from "@/lib/codex/store";
import { optionalEnv } from "@/lib/env";

const grantSchema = z.object({
  purpose: z.literal("codex-inference"),
  user: z.uuid(),
  org: z.uuid().nullable(),
  key: z.string(),
  generation: z.uuid(),
});
export type CodexGrant = z.infer<typeof grantSchema>;
/** Scoped broker credentials only. No OAuth token is sent to a computer. */
export function inferenceGrant(
  user: string,
  org: string | undefined,
  row: Connection,
): string {
  const origin = optionalEnv("RUNTIME_BASE_URL");
  if (!origin)
    throw new Error("RUNTIME_BASE_URL is required for Codex account sessions");
  const url = new URL("/api/runtime/codex", origin).toString();
  const bearer = seal(
    JSON.stringify({
      purpose: "codex-inference",
      user,
      org: org ?? null,
      key: row.key,
      generation: row.generation,
    }),
  );
  return Buffer.from(JSON.stringify({ url, bearer })).toString("base64url");
}
export function readGrant(bearer: string): CodexGrant {
  try {
    return grantSchema.parse(JSON.parse(open(bearer)));
  } catch {
    throw revoked();
  }
}
/** Uncached, after each awaited credential read/refresh and before upstream use.
 * Personal grants are also bound to the session's org when it has one. */
export async function authorizeGrant(grant: CodexGrant): Promise<void> {
  const { data, error } = await createSupabaseAdminClient().rpc(
    "codex_connection_use",
    {
      k: grant.key,
      actor: grant.user,
      requested_org: grant.org,
      gen: grant.generation,
    },
  );
  if (error) throw new Error("Could not authorize Codex request");
  if (!data) throw revoked();
}

/** Personal credentials precede org defaults. An existing personal API key
 * remains preferred to an org account until the user explicitly picks it. */
export async function accountForSession(
  user: string,
  org: string | undefined,
  personalKey: boolean,
  explicit: boolean,
): Promise<Connection | null> {
  return selectCodexAccount(user, org, personalKey, explicit, {
    store: codexStore,
    memberRole,
  });
}
