import { redirect } from "next/navigation";

import { SignInButton } from "@/components/signin-button";
import { getOwnerSafe } from "@/lib/auth/owner";
import { safeRelativePath } from "@/lib/auth/redirect";

export const dynamic = "force-dynamic";

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
      <div className="w-full max-w-xs space-y-10">
        {/* The home screen's wordmark, so signing in already looks like the app. */}
        <div className="space-y-3 text-center">
          <p aria-hidden className="select-none font-display text-6xl leading-none text-foreground/25">
            outrunner
          </p>
          <h1 className="text-sm text-muted-foreground">Sign in to run your coding agents.</h1>
        </div>

        {message && (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
          >
            {message}
          </div>
        )}

        <SignInButton next={target} />
      </div>
    </main>
  );
}
