import { bearerToken, hashSecret } from "@/lib/auth/cli-login";
import { isOwner, ownerFromUser, type Owner } from "@/lib/auth/owner";
import { cliTokenUserId } from "@/lib/db/cli-tokens";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * The owner a request's CLI token (`Authorization: Bearer or_cli_…`) signs in,
 * or null for none, a revoked one, or a user the allowlist no longer lets in.
 * The CLI's counterpart to getOwner(): a route that serves the CLI asks this,
 * and needs no Origin check, since a bearer token isn't sent by the browser on
 * its own the way a cookie is.
 */
export async function getCliOwner(request: Request): Promise<Owner | null> {
  const token = bearerToken(request.headers);
  if (!token) return null;
  const userId = await cliTokenUserId(hashSecret(token));
  if (!userId) return null;
  const { data, error } = await createSupabaseAdminClient().auth.admin.getUserById(userId);
  if (error || !data.user || !isOwner(data.user)) return null;
  return ownerFromUser(data.user);
}
