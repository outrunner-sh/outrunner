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
    <main className="flex min-h-screen flex-col items-center px-6 py-10">
      <div className="flex w-full flex-1 flex-col items-center justify-center">
        <div className="w-full max-w-sm space-y-8">
          {/* The home screen's wordmark, so signing in already looks like the app. */}
          <div className="space-y-3 text-center">
            <p aria-hidden className="select-none font-display text-6xl leading-none text-foreground/25">
              outrunner
            </p>
            <h1 className="text-sm text-muted-foreground">Run fleets of coding agents in the cloud.</h1>
          </div>

          <div className="space-y-4">
            {message && (
              <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
                {message}
              </p>
            )}
            <SignInButton next={target} />
            <p className="text-center text-xs text-muted-foreground">
              GitHub signs you in and gives your agents your repositories.
            </p>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground/60">Free to start. No card needed.</p>
    </main>
  );
}
