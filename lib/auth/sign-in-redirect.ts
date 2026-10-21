import { safeRelativePath } from "@/lib/auth/redirect";

/**
 * Whether a request is signed in, as the proxy sees it: "unknown" when Supabase
 * couldn't be asked (a network hiccup), which must not sign anyone out.
 */
export type SignedIn = boolean | "unknown";

/** Paths anyone may open: signing in itself, and the routes that do their own
 *  sign-in handling. Matched as the whole path or a prefix ending in "/". */
const PUBLIC_PATHS = ["/signin", "/auth", "/upgrade"];

/**
 * Where the proxy sends a request that needs signing in, or null to let it
 * through. One gate for every app page, so a page needs no check of its own and
 * can render without asking the server.
 *
 * Let through: anyone signed in (or not known to be signed out); API routes,
 * which answer 401 themselves; the public paths; and anything but a page load
 * (GET/HEAD), so a form or server action posted at sign-out isn't turned into a
 * redirect. The rest goes to sign-in with the path and query it asked for as
 * `next`, so sign-in brings the user back there.
 */
export function signInRedirect(request: {
  method: string;
  pathname: string;
  search: string;
  signedIn: SignedIn;
}): string | null {
  const { method, pathname, search, signedIn } = request;
  if (signedIn !== false) return null;
  if (method !== "GET" && method !== "HEAD") return null;
  if (pathname === "/api" || pathname.startsWith("/api/")) return null;
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return null;

  const next = safeRelativePath(`${pathname}${search}`);
  return next === "/" ? "/signin" : `/signin?next=${encodeURIComponent(next)}`;
}
