import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DesktopSignIn } from "@/components/desktop-signin";
import { DESKTOP_CONTEXT_COOKIE, readDesktopContext } from "@/lib/auth/desktop/grant";
import { EmailSignIn } from "@/components/email-signin";
import { SignInButton } from "@/components/signin-button";
import { getOwnerSafe } from "@/lib/auth/owner";
import { safeRelativePath } from "@/lib/auth/redirect";
import { cn } from "@/lib/utils";

/** Human-readable copy for the error codes `/auth/callback` can return. */
const ERROR_MESSAGES: Record<string, string> = {
  not_owner:
    "That account can't sign in here. Only the configured owner can.",
  missing_code: "Sign-in did not complete. Please try again.",
  exchange_failed: "Could not verify the sign-in. Please try again.",
  access_denied: "Sign-in was cancelled.",
  reconnect_other_account:
    "GitHub came back signed in as a different account than the one linked to your Outrunner account, so nothing was changed. Sign in to GitHub as your linked account, then sign in here and reconnect.",
};

function errorMessage(code: string | undefined, org: string | undefined): string | null {
  if (!code) return null;
  // Asked to join the org that claimed their email's domain (lib/orgs/admission.ts).
  const name = org?.slice(0, 80) || "your team's org";
  if (code === "join_requested") {
    return `You've asked to join ${name}. Its admins will see your request; sign in again once one approves it.`;
  }
  if (code === "invited") {
    return "You've been invited to an org. Open the invite link you were sent, and sign in from there to join.";
  }
  if (code === "join_declined") {
    return `${name}'s admins declined your request to join. You can ask again in a few days, or ask an admin to invite you.`;
  }
  return Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code]
    : "Sign-in failed. Please try again.";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; org?: string }>;
}) {
  const { next, error, org } = await searchParams;
  const desktop = readDesktopContext((await cookies()).get(DESKTOP_CONTEXT_COOKIE)?.value);
  const target = safeRelativePath(next, desktop ? "/auth/desktop/ready" : "/");

  // Already signed in as the owner — skip the screen entirely.
  if (await getOwnerSafe()) redirect(target);

  const message = errorMessage(error, org);

  return (
    <DesktopSignIn next={target}>
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-4 text-center">
            {/* The home screen's wordmark, small, as the mark above the welcome. */}
            <p aria-hidden className="select-none font-display text-4xl leading-none text-foreground/25">
              outrunner
            </p>
            <div className="space-y-1">
              <h1 className="text-base font-medium text-foreground">Welcome to Outrunner</h1>
              <p className="text-sm text-muted-foreground">Sign in or create an account</p>
            </div>
          </div>
          {message && (
            // A request to join waiting on an org's admins isn't a failure.
            <p
              role={error === "join_requested" ? "status" : "alert"}
              className={cn(
                "text-center text-xs",
                error === "join_requested" ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {message}
            </p>
          )}
          <div className="space-y-2">
            <SignInButton provider="github" next={target} />
            <SignInButton provider="google" next={target} />
          </div>
          <p aria-hidden className="flex items-center gap-3 text-[10px] tracking-wider text-muted-foreground uppercase">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </p>
          <EmailSignIn next={target} />
        </div>
      </main>
    </DesktopSignIn>
  );
}
