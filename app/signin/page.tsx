import { redirect } from "next/navigation";

import { SignInButton } from "@/components/signin-button";
import { getOwnerSafe } from "@/lib/auth/owner";
import { safeRelativePath } from "@/lib/auth/redirect";

/** Human-readable copy for the error codes `/auth/callback` can return. */
const ERROR_MESSAGES: Record<string, string> = {
  not_owner:
    "That GitHub account can't sign in here. Only the configured owner can.",
  missing_code: "Sign-in did not complete. Please try again.",
  exchange_failed: "Could not verify the sign-in with GitHub. Please try again.",
  access_denied: "Sign-in was cancelled.",
};

function errorMessage(code: string | undefined, org: string | undefined): string | null {
  if (!code) return null;
  // Asked to join the org that claimed their email's domain (lib/orgs/admission.ts).
  const name = org?.slice(0, 80) || "your team's org";
  if (code === "join_requested") {
    return `You've asked to join ${name}. Its admins will see your request; sign in again once one approves it.`;
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
  const target = safeRelativePath(next);

  // Already signed in as the owner — skip the screen entirely.
  if (await getOwnerSafe()) redirect(target);

  const message = errorMessage(error, org);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="space-y-10">
        {/* The home screen's wordmark, so signing in already looks like the app. */}
        <p aria-hidden className="select-none font-display text-7xl leading-none text-foreground/25">
          outrunner
        </p>
        <div className="space-y-6">
          <h1 className="text-sm text-muted-foreground">Sign in to continue.</h1>
          {message && (
            // A request to join waiting on an org's admins isn't a failure.
            <p
              role={error === "join_requested" ? "status" : "alert"}
              className={error === "join_requested" ? "max-w-sm text-xs text-muted-foreground" : "max-w-sm text-xs text-destructive"}
            >
              {message}
            </p>
          )}
          <SignInButton next={target} />
        </div>
      </div>
    </main>
  );
}
