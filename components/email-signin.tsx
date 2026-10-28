"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/loaders";
import { InlineMessage } from "@/components/ui/notice";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Sign in with a one-time code sent to an email address, in two steps: the
 * address, then the code. Supabase sends the code from here; `/auth/email`
 * checks it, so the sign-in goes through the same allowlist and org admission
 * as GitHub's and Google's. Signs up an address it hasn't seen, as they do.
 */
export function EmailSignIn({ next = "/" }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setPending(true);
    setError(null);
    try {
      const { error } = await createSupabaseBrowserClient().auth.signInWithOtp({
        email: email.trim(),
        // The email may carry a link as well as (or, with Supabase's default
        // template, instead of) the code: it lands at /auth/callback, which
        // signs in as an OAuth return does.
        options: {
          shouldCreateUser: true,
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw error;
      setSent(true);
      setCode("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send the code.");
    } finally {
      setPending(false);
    }
  }

  async function verifyCode() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/auth/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), token: code, next }),
      });
      const body = (await response.json().catch(() => null)) as { redirect?: string; error?: string } | null;
      if (!response.ok || !body?.redirect) throw new Error(body?.error ?? "Could not sign in. Try again.");
      // Keep the spinner: the page is on its way.
      window.location.assign(body.redirect);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not sign in. Try again.");
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        void (sent ? verifyCode() : sendCode());
      }}
    >
      {sent ? (
        <>
          <p className="text-center text-xs text-muted-foreground">
            Check <span className="text-foreground">{email.trim()}</span>: enter the code, or open the link.{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                setSent(false);
                setError(null);
              }}
            >
              Use another email
            </button>
          </p>
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Code"
            aria-label="Code from the email"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={10}
            autoFocus
            required
            className="h-8 rounded-md text-center font-mono tracking-[0.3em] placeholder:font-sans placeholder:tracking-normal md:text-sm"
          />
        </>
      ) : (
        <Input
          type="email"
          name="email"
          autoComplete="email"
          placeholder="Email address"
          aria-label="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          className="h-8 rounded-md md:text-sm"
        />
      )}
      <button
        type="submit"
        aria-busy={pending || undefined}
        className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-foreground text-sm font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {pending && <Spinner className="size-4" />}
        {sent ? "Sign in" : pending ? "Sending code" : "Continue with email"}
      </button>
      {sent && (
        <button
          type="button"
          disabled={pending}
          className="mx-auto block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => void sendCode()}
        >
          Send a new code
        </button>
      )}
      {error && <InlineMessage>{error}</InlineMessage>}
    </form>
  );
}
