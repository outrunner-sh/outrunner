import { redirect } from "next/navigation";

import { getOwnerSafe } from "@/lib/auth/owner";

/**
 * Sends a signed-in user who isn't the allowlisted owner to sign-in (signed
 * out is the proxy's to catch). Rendered under Suspense, so the page shows
 * without waiting on it. Shows nothing.
 */
export async function RequireOwner() {
  if (!(await getOwnerSafe())) redirect("/signin");
  return null;
}
