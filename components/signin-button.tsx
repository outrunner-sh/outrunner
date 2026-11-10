"use client";

import { useState } from "react";

import { GitHubIcon, GoogleIcon } from "@/components/brand-icons";
import { Spinner } from "@/components/ui/loaders";
import { InlineMessage } from "@/components/ui/notice";
import type { SignInProvider } from "@/lib/auth/identity";
import { isDesktopApp } from "@/lib/is-desktop";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Where the desktop shell listens for the OAuth redirect. Must match
 * `OAUTH_PORT` in runtime-desktop/src-tauri/src/lib.rs, and be listed in the
 * Supabase redirect allowlist.
 */
const DESKTOP_OAUTH_REDIRECT = "http://127.0.0.1:47823";

/**
 * GitHub's scopes: the account login and verified emails, and `repo`, since
 * the token this sign-in mints is the one repository work runs as. Google asks
 * for Supabase's defaults (openid, email, profile): identity alone.
 */
const SCOPES: Record<SignInProvider, string | undefined> = {
  github: "read:user user:email repo",
  google: undefined,
};

const PROVIDERS: Record<SignInProvider, { name: string; icon: React.ReactNode }> = {
  github: { name: "GitHub", icon: <GitHubIcon className="size-4" /> },
  google: { name: "Google", icon: <GoogleIcon className="size-4" /> },
};

/**
 * Starts an OAuth (PKCE) flow from the browser. Supabase stores the code
 * verifier in a cookie and redirects to the provider; the `/auth/callback`
 * route completes the exchange and enforces the owner allowlist.
 *
 * `link` adds the provider to the signed-in account instead of signing in
 * (Supabase's manual identity linking): how someone who signed in with Google
 * connects GitHub. The callback stores the GitHub token either way.
 */
async function startOAuth(provider: SignInProvider, next: string, link: boolean): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const begin = (options: { redirectTo: string; skipBrowserRedirect?: boolean }) => {
    const credentials = { provider, options: { ...options, scopes: SCOPES[provider] } };
    return link ? supabase.auth.linkIdentity(credentials) : supabase.auth.signInWithOAuth(credentials);
  };

  // Desktop shell: GitHub and Google block or render poorly in the embedded
  // webview (Google refuses embedded user agents outright), so authorize in
  // the system browser. `skipBrowserRedirect` keeps the PKCE verifier here in
  // the webview; the code returns to the shell's loopback listener, which
  // feeds it to this app's `/auth/callback` so the exchange (and the session
  // cookie) happen here rather than in the browser.
  if (isDesktopApp()) {
    // Loopback, not the `runtime://` scheme: RFC 8252 recommends it for
    // native apps, it needs no OS-level scheme registration (which on macOS
    // only happens for a registered .app bundle), and the provider
    // allowlist takes an ordinary http entry. The desktop shell listens on
    // this fixed port and hands the code to this webview, so the PKCE
    // verifier and the session cookie both stay here.
    const redirectTo = `${DESKTOP_OAUTH_REDIRECT}?next=${encodeURIComponent(next)}`;
    const { data, error } = await begin({ redirectTo, skipBrowserRedirect: true });
    if (error) throw error;
    // Navigating to the provider URL is intercepted by the shell, which
    // opens it in the system browser. Keep the spinner: the deep link drives
    // the rest of the flow.
    if (data?.url) window.location.assign(data.url);
    return;
  }

  const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
  const { error } = await begin({ redirectTo });
  // On success the browser navigates away, so we only reach here on failure.
  if (error) throw error;
}

export function SignInButton({
  provider = "github",
  next = "/",
  link = false,
  label,
}: {
  provider?: SignInProvider;
  next?: string;
  /** Connect the provider to the signed-in account rather than sign in. */
  link?: boolean;
  /** Overrides the idle label, e.g. "Reconnect GitHub". */
  label?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { name, icon } = PROVIDERS[provider];

  async function signIn() {
    setLoading(true);
    setError(null);
    try {
      await startOAuth(provider, next, link);
    } catch (error) {
      setError(error instanceof Error ? error.message : `Could not start ${link ? "connecting" : "sign-in"}.`);
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {/* The mark at the left edge, the label centred across the width. */}
      <button
        type="button"
        aria-busy={loading || undefined}
        onClick={() => {
          if (!loading) void signIn();
        }}
        className="relative flex h-8 w-full items-center justify-center rounded-md border border-border bg-input/30 px-9 text-sm text-foreground transition-colors hover:bg-input/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="absolute left-3 flex items-center">{loading ? <Spinner className="size-4" /> : icon}</span>
        {loading ? `Opening ${name}` : (label ?? (link ? `Connect ${name}` : `Continue with ${name}`))}
      </button>
      {error && <InlineMessage>{error}</InlineMessage>}
    </div>
  );
}
