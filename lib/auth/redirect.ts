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

  // A browser reads a Location the way URL does: it drops tabs and newlines
  // and turns `\` into `/`, so `/<tab>/evil.com` is `//evil.com` to it. Parsed
  // here the same way, it must still be this origin. It goes on as given, not
  // as parsed: parsing also resolves dot segments, and `/.//evil.com`, this
  // origin's path `//evil.com`, would come out as `//evil.com` itself.
  try {
    if (new URL(next, SELF).origin !== SELF) return fallback;
  } catch {
    return fallback;
  }
  return next;
}
