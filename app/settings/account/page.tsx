import Image from "next/image";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { signOut } from "@/app/auth/actions";
import { SettingsLoading } from "@/components/settings-loading";
import { SignOutButton } from "@/components/sign-out-button";
import { getOwnerSafe } from "@/lib/auth/owner";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Account: the signed-in GitHub identity, and sign-out — which is also how a
 *  revoked GitHub token is replaced (see components/github-reconnect-link). */
export default function AccountSettings() {
  return (
    <Suspense fallback={<SettingsLoading title="Account" />}>
      <AccountSection />
    </Suspense>
  );
}

async function AccountSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold text-foreground">Account</h1>

      <div className="flex items-center gap-3">
        {owner.avatarUrl ? (
          <Image
            src={owner.avatarUrl}
            alt=""
            width={40}
            height={40}
            className="size-10 rounded-full border border-border/60"
          />
        ) : (
          <span className="size-10 rounded-full bg-accent" />
        )}
        <div>
          <p className="text-sm font-medium text-foreground">
            {owner.githubLogin || "signed in"}
          </p>
          <p className="text-xs text-muted-foreground">Signed in with GitHub</p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          If GitHub stops working (repositories won’t load, or publishing fails),
          sign out and back in to reconnect your account.
        </p>
        <form action={signOut}>
          <SignOutButton />
        </form>
      </div>
    </section>
  );
}
