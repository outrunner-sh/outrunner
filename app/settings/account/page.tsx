import { PageHeader } from "@/components/page-layout";

import Image from "next/image";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { signOut } from "@/app/auth/actions";

import { SettingsLoading } from "@/components/settings-loading";
import { SignInButton } from "@/components/signin-button";
import { SignOutButton } from "@/components/sign-out-button";
import { hasGithubIdentity } from "@/lib/auth/identity";
import { getAuthUser, getOwnerSafe } from "@/lib/auth/owner";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = {
  prefetch: "static",
  // Set only on the way back from a failed Connect GitHub.
  samples: [{ searchParams: { link_error: null } }],
};

/** Account: the signed-in identity; how the user hears of their sessions
 *  (components/notification-settings.tsx); who sessions work on GitHub as
 *  (lib/github/identity.ts), or connecting GitHub to an account that signed
 *  in with Google or an emailed code, or reconnecting it for a fresh token
 *  (see components/github-reconnect-link); and sign-out. */
/** Why connecting GitHub failed, by the error code Supabase sent back
 *  (app/auth/callback). Codes only: the URL's own text is never shown. */
const LINK_ERRORS: Record<string, string> = {
  identity_already_exists:
    "That GitHub account is already linked to another Outrunner account. Sign in with GitHub to use that account, or connect a different GitHub account.",
  manual_linking_disabled: "Connecting GitHub isn't turned on for this deployment yet.",
};

export default function AccountSettings({ searchParams }: { searchParams: Promise<{ link_error?: string }> }) {
  return (
    <Suspense fallback={<SettingsLoading title="Profile" />}>
      <AccountSection searchParams={searchParams} />
    </Suspense>
  );
}

async function AccountSection({ searchParams }: { searchParams: Promise<{ link_error?: string }> }) {
  const { link_error: linkError } = await searchParams;
  const linkMessage = linkError
    ? Object.hasOwn(LINK_ERRORS, linkError)
      ? LINK_ERRORS[linkError]
      : "Couldn't connect GitHub. Please try again."
    : null;
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");
  const user = await getAuthUser();
  const githubLinked = user ? hasGithubIdentity(user) : false;
  const providers = [
    githubLinked && "GitHub",
    user?.identities?.some((i) => i.provider === "google") && "Google",
    user?.identities?.some((i) => i.provider === "email") && "an emailed code",
  ].filter(Boolean);

  return (
    <section className="space-y-6">
      <PageHeader title="Profile" />

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
            {owner.githubLogin || owner.name || owner.email || "signed in"}
          </p>
          <p className="text-xs text-muted-foreground">
            {providers.length ? `Signed in with ${providers.join(" and ")}` : "Signed in"}
          </p>
        </div>
      </div>

      {githubLinked ? (
        <>
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              If GitHub stops working (repositories won’t load, or publishing fails),
              reconnect it for a fresh connection. You stay signed in.
            </p>
            {linkMessage && (
              <p role="alert" className="text-xs text-destructive">
                {linkMessage}
              </p>
            )}
            <div className="max-w-xs">
              <SignInButton provider="github" reconnect next="/settings/account" />
            </div>
          </div>
          <div>
            <form action={signOut}>
              <SignOutButton />
            </form>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              Connect GitHub to work on your repositories: sessions clone, push
              and open pull requests as your GitHub account.
            </p>
            {linkMessage && (
              <p role="alert" className="text-xs text-destructive">
                {linkMessage}
              </p>
            )}
            <div className="max-w-xs">
              <SignInButton provider="github" link next="/settings/account" />
            </div>
          </div>
          <form action={signOut}>
            <SignOutButton />
          </form>
        </>
      )}
    </section>
  );
}
