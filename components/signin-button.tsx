"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { isDesktopApp } from "@/lib/is-desktop";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/** The GitHub "Octocat" mark. Inlined so it does not depend on a lucide icon. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="size-4">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Starts the GitHub OAuth (PKCE) flow from the browser. Supabase stores the
 * code verifier in a cookie and redirects to GitHub; the `/auth/callback`
 * route completes the exchange and enforces the owner allowlist.
 *
 * OAuth is used for identity only — repository access uses a separate PAT —
 * so the requested scopes are the minimum needed to read the account login.
 */
/**
 * Where the desktop shell listens for the OAuth redirect. Must match
 * `OAUTH_PORT` in runtime-desktop/src-tauri/src/lib.rs, and be listed in the
 * Supabase redirect allowlist.
 */
const DESKTOP_OAUTH_REDIRECT = "http://127.0.0.1:47823";

export function SignInButton({ next = "/" }: { next?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setLoading(true);
    setError(null);

    try {
      const supabase = createSupabaseBrowserClient();

      // Desktop shell: GitHub blocks/renders poorly in the embedded webview, so
      // authorize in the system browser. `skipBrowserRedirect` keeps the PKCE
      // verifier here in the webview; the code returns to the shell's loopback
      // listener, which feeds it to this app's `/auth/callback` so the exchange
      // (and the session cookie) happen here rather than in the browser.
      if (isDesktopApp()) {
        // Loopback, not the `runtime://` scheme: RFC 8252 recommends it for
        // native apps, it needs no OS-level scheme registration (which on macOS
        // only happens for a registered .app bundle), and the provider
        // allowlist takes an ordinary http entry. The desktop shell listens on
        // this fixed port and hands the code to this webview, so the PKCE
        // verifier and the session cookie both stay here.
        const redirectTo = `${DESKTOP_OAUTH_REDIRECT}?next=${encodeURIComponent(next)}`;
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider: "github",
          options: { redirectTo, scopes: "read:user user:email repo", skipBrowserRedirect: true },
        });
        if (error) throw error;
        // Navigating to the provider URL is intercepted by the shell, which
        // opens it in the system browser. Keep the spinner: the deep link drives
        // the rest of the flow.
        if (data?.url) window.location.assign(data.url);
        return;
      }

      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo, scopes: "read:user user:email repo" },
      });

      // On success the browser navigates away, so we only reach here on failure.
      if (error) throw error;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not start sign-in.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {/* The app's primary button (light on dark), not near-black on black. */}
      <LoadingButton
        size="sm"
        status={loading ? "pending" : "idle"}
        labels={{ idle: "Continue with GitHub", pending: "Opening GitHub" }}
        icon={<GitHubMark />}
        trailingIcon={<ArrowRight className="size-3.5" />}
        onClick={() => void signIn()}
        className="rounded-none"
      />
      {error && <InlineMessage>{error}</InlineMessage>}
    </div>
  );
}
