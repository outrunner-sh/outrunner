import { redirect } from "next/navigation";

import { CredentialsSettings } from "@/components/credentials-settings";
import { getOwner } from "@/lib/auth/owner";
import { credentialStatus } from "@/lib/db/credentials";

export const dynamic = "force-dynamic";

/**
 * Credentials settings. Status is read on the server so the page paints with
 * the real state rather than flashing "not connected" while a fetch lands.
 *
 * Only presence and a masked hint cross to the client — {@link credentialStatus}
 * never returns a stored secret.
 */
export default async function CredentialsSettingsPage() {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/credentials");

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="mb-1 text-lg font-medium">Credentials</h1>
      <p className="mb-8 text-sm text-muted-foreground">
        Runtime runs your workspaces on your own credentials.
      </p>
      <CredentialsSettings initial={await credentialStatus(owner.id)} />
    </main>
  );
}
