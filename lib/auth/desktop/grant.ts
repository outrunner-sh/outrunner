import { createHash } from "node:crypto";

import { safeRelativePath } from "@/lib/auth/redirect";
import { open, sameSecret, seal } from "@/lib/crypto/secret-box";

export const DESKTOP_CONTEXT_COOKIE = "outrunner-desktop-signin";
export const DESKTOP_CONTEXT_SECONDS = 60 * 60;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

export type DesktopContext = { state: string; challenge: string; next: string; expires: number };

export function desktopContext(state: unknown, challenge: unknown, next: string | null, now = Date.now()): DesktopContext | null {
  if (typeof state !== "string" || !OPAQUE.test(state) || typeof challenge !== "string" || !OPAQUE.test(challenge)) return null;
  return { state, challenge, next: desktopDestination(next), expires: now + DESKTOP_CONTEXT_SECONDS * 1000 };
}

/** Auth routes and onboarding cannot be the destination of a completed login. */
export function desktopDestination(next: string | null | undefined): string {
  const path = safeRelativePath(next);
  const url = new URL(path, "https://desktop.invalid");
  if (url.origin !== "https://desktop.invalid" || /^\/(?:auth|signin|onboarding)(?:\/|$)/.test(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function sealDesktopContext(context: DesktopContext): string {
  return seal(JSON.stringify({ purpose: "desktop-context", ...context }));
}

export function readDesktopContext(cookie: string | undefined, now = Date.now()): DesktopContext | null {
  try {
    if (!cookie || cookie.length > 8192) return null;
    const value = JSON.parse(open(cookie));
    if (value.purpose !== "desktop-context" || !Number.isFinite(value.expires) || value.expires <= now) return null;
    const context = desktopContext(value.state, value.challenge, value.next, now);
    return context ? { ...context, expires: value.expires } : null;
  } catch {
    return null;
  }
}

type DesktopGrant = DesktopContext & { ownerId: string; tokenHash: string; origin: string; orgId: string | null };

/** The Supabase OTP is encrypted, short lived, and bound to a native PKCE verifier.
 * Supabase consumes the OTP once, so redeeming never reuses the browser session. */
export function sealDesktopGrant(context: DesktopContext, ownerId: string, tokenHash: string, origin: string, next: string, now = Date.now(), orgId: string | null = null): string {
  return seal(JSON.stringify({
    purpose: "desktop-session", ...context, ownerId, tokenHash, origin, orgId,
    next: desktopDestination(next), expires: Math.min(context.expires, now + 60_000),
  }));
}

export function readDesktopGrant(ticket: unknown, verifier: unknown, state: unknown, origin: string, now = Date.now()): DesktopGrant | null {
  try {
    if (typeof ticket !== "string" || ticket.length > 8192 || typeof verifier !== "string" || !OPAQUE.test(verifier)) return null;
    const value = JSON.parse(open(ticket));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (value.purpose !== "desktop-session" || value.origin !== origin || value.state !== state ||
        !Number.isFinite(value.expires) || value.expires <= now ||
        typeof value.challenge !== "string" || !sameSecret(value.challenge, challenge) ||
        typeof value.ownerId !== "string" || !value.ownerId || typeof value.tokenHash !== "string" || !value.tokenHash) return null;
    return { ...value, next: desktopDestination(value.next) };
  } catch {
    return null;
  }
}
