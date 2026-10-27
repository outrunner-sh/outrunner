"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { isDesktopApp } from "@/lib/is-desktop";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

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
        icon={<GitHubIcon className="size-4" />}
        trailingIcon={<ArrowRight className="size-3.5" />}
        onClick={() => void signIn()}
        className="rounded-none"
      />
      {error && <InlineMessage>{error}</InlineMessage>}
    </div>
  );
}
