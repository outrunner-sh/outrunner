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

function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code]
    : "Sign-in failed. Please try again.";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const target = safeRelativePath(next);

  // Already signed in as the owner — skip the screen entirely.
  if (await getOwnerSafe()) redirect(target);

  const message = errorMessage(error);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="space-y-10">
        {/* The home screen's wordmark, so signing in already looks like the app. */}
        <p aria-hidden className="select-none font-display text-7xl leading-none text-foreground">
          outrunner
        </p>
        <div className="space-y-6">
          <h1 className="text-sm text-muted-foreground">Sign in to continue.</h1>
          {message && (
            <p role="alert" className="text-xs text-destructive">
              {message}
            </p>
          )}
          <SignInButton next={target} />
        </div>
      </div>
    </main>
  );
}
