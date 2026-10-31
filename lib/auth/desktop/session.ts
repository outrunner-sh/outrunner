import type { User } from "@supabase/supabase-js";

import { isOwner } from "@/lib/auth/allowlist";
import { type DesktopContext, readDesktopGrant, sealDesktopGrant } from "@/lib/auth/desktop/grant";

type Login = { user: { id: string } | null; properties: { hashed_token: string } | null };
type Auth = {
  verifyOtp: (params: { token_hash: string; type: "email" }) => Promise<{ data: { user: User | null }; error: unknown }>;
  signOut: (params: { scope: "local" }) => Promise<unknown>;
};

/** Generate for the authenticated account only; a changed email or a provider
 * returning a different user must never sign that other account into the app. */
export async function createDesktopTicket(
  owner: { id: string; email: string }, context: DesktopContext, origin: string, next: string,
  generate: (email: string) => Promise<{ data: Login; error: unknown }>,
  orgId: string | null = null,
): Promise<string | null> {
  const { data, error } = await generate(owner.email);
  if (error || data.user?.id !== owner.id || !data.properties?.hashed_token) return null;
  return sealDesktopGrant(context, owner.id, data.properties.hashed_token, origin, next, Date.now(), orgId);
}

/** OTP verification creates a separate session, consumed once by Supabase.
 * Its client writes the webview cookies, never the browser's refresh token. */
export async function redeemDesktopTicket(
  body: { ticket?: unknown; verifier?: unknown; state?: unknown } | null, origin: string, auth: Auth,
): Promise<{ next: string; orgId?: string } | { error: string; status: number }> {
  const grant = readDesktopGrant(body?.ticket, body?.verifier, body?.state, origin);
  if (!grant) return { error: "Desktop sign-in expired or was invalid. Start again from the app.", status: 400 };
  const { data, error } = await auth.verifyOtp({ token_hash: grant.tokenHash, type: "email" });
  if (error || !data.user) return { error: "That sign-in has expired or was already used. Start again.", status: 401 };
  if (data.user.id !== grant.ownerId || !isOwner(data.user)) {
    await auth.signOut({ scope: "local" });
    return { error: "That account cannot sign in here.", status: 403 };
  }
  return { next: grant.next, ...(grant.orgId && { orgId: grant.orgId }) };
}
