/**
 * Post-sign-in redirect safety.
 *
 * The `next` parameter travels through the OAuth round trip as an untrusted
 * query string, so it must never be used to build an absolute redirect. This
 * guard collapses anything that could leave the app's own origin down to a
 * safe relative path, defeating open-redirect phishing (`?next=//evil.com`).
 */
const SELF = "https://outrunner.invalid";

export function safeRelativePath(
  next: string | null | undefined,
  fallback = "/",
): string {
  if (!next) return fallback;

  // Must be a single-slash, same-origin path. Reject:
  //   //evil.com        protocol-relative → another origin
  //   /\evil.com        backslash variant some browsers normalise to //
  //   https://evil.com  absolute URL
  //   anything not starting with "/"
  if (
    !next.startsWith("/") ||
    next.startsWith("//") ||
    next.startsWith("/\\")
  ) {
    return fallback;
  }

  // Control characters never belong in a path, and a Location carrying a
  // newline is one Node refuses to send (a 500 rather than a redirect).
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;

  // Backstop: parsed the way a browser reads a Location, it must still be this
  // origin. It goes on as given, not as parsed: parsing resolves dot segments,
  // and `/.//evil.com`, this origin's path `//evil.com`, would come out as
  // `//evil.com` itself.
  try {
    if (new URL(next, SELF).origin !== SELF) return fallback;
  } catch {
    return fallback;
  }
  return next;
}
