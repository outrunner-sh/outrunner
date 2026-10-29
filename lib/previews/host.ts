/**
 * Where previews live: `<slug>.<RUNTIME_PREVIEW_DOMAIN>`, a site of their
 * own. Shared by the app (which makes the links) and the custom server's
 * proxy (server.ts, lib/previews/proxy.ts), which Node runs as is: so this
 * imports nothing from the app, and reads process.env itself.
 *
 * A preview runs whatever the session's code is, script and all, in the
 * visitor's browser. On the app's own origin that script could read the
 * app's pages and call its routes as the visitor; under the app's site it
 * could set cookies the app reads and ride its SameSite cookies. So the
 * preview domain must be another site altogether, and one that isn't is
 * refused here rather than trusted: previews are then off.
 */

/** A preview's slug: its link's host label, random, never reused. */
export const PREVIEW_SLUG = /^[a-z0-9]{20}$/;
export const PREVIEW_SLUG_LENGTH = 20;

/** Paths on a preview's host that are Outrunner's, not the box's: signing a
 *  visitor in, waking a session. A server's own path there is out of reach,
 *  which is the price of needing no other host for them. */
export const PREVIEW_PATH_PREFIX = "/__outrunner/";

export type PreviewDomain = {
  /** The domain previews are subdomains of, with a port where it has one
   *  (`localhost:3000` in development). Lowercase. */
  host: string;
  /** Whether links are https: everywhere but a development localhost. */
  secure: boolean;
};

type Env = Record<string, string | undefined>;

/** Whether `hostname` is this machine, where development runs on http. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** The last two labels of a hostname: as near to its site as can be told
 *  without the public suffix list, and erring towards calling two hosts the
 *  same site (`a.co.uk`, `b.co.uk`), which only refuses a domain. */
function siteOf(hostname: string): string {
  return hostname.split(".").slice(-2).join(".");
}

/**
 * The preview domain this deployment serves, or why it serves none: unset,
 * malformed, or on the app's own site (RUNTIME_BASE_URL).
 */
export function previewDomainOf(env: Env = process.env): { ok: true; domain: PreviewDomain } | { ok: false; reason: string } {
  const raw = (env.RUNTIME_PREVIEW_DOMAIN ?? "").trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
  if (!raw) return { ok: false, reason: "RUNTIME_PREVIEW_DOMAIN is not set." };
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(raw)) {
    return { ok: false, reason: `RUNTIME_PREVIEW_DOMAIN "${raw}" isn't a domain.` };
  }
  const hostname = raw.replace(/:\d+$/, "");
  const secure = !isLoopback(hostname);

  let app: URL | null = null;
  try {
    app = env.RUNTIME_BASE_URL ? new URL(env.RUNTIME_BASE_URL) : null;
  } catch {
    app = null;
  }
  if (!app) return { ok: false, reason: "RUNTIME_BASE_URL is not set, so previews can't send visitors to sign in." };
  const appHost = app.hostname.toLowerCase();
  // Development serves both on localhost, which no one else can reach.
  if (!(isLoopback(appHost) && !secure) && siteOf(appHost) === siteOf(hostname)) {
    return {
      ok: false,
      reason: `RUNTIME_PREVIEW_DOMAIN "${raw}" is on the app's own site (${appHost}): previews need a domain of their own.`,
    };
  }
  return { ok: true, domain: { host: raw, secure } };
}

/** The preview domain, or null when previews are off. */
export function previewDomain(env: Env = process.env): PreviewDomain | null {
  const found = previewDomainOf(env);
  return found.ok ? found.domain : null;
}

/** A preview's link: its origin, with no path. */
export function previewOrigin(slug: string, domain: PreviewDomain): string {
  return `${domain.secure ? "https" : "http"}://${slug}.${domain.host}`;
}

/**
 * The slug a request's host names, or null for a host that isn't a
 * preview's: exactly one label, a slug's, before the preview domain. A
 * default port is the same host without one.
 */
export function slugFromHost(hostHeader: string | undefined | null, domain: PreviewDomain): string | null {
  if (!hostHeader) return null;
  let host = hostHeader.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!/:\d+$/.test(domain.host)) host = host.replace(domain.secure ? /:443$/ : /:80$/, "");
  const suffix = `.${domain.host}`;
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  return PREVIEW_SLUG.test(slug) ? slug : null;
}

/**
 * The cookie a signed-in visitor's preview session rides in. `__Host-` on
 * https: the browser keeps it to the one preview's host (no Domain, Path /,
 * Secure), so no other preview can set or read it. Plain http (development)
 * can't hold a `__Host-` cookie.
 */
export function previewCookieName(domain: PreviewDomain): string {
  return domain.secure ? "__Host-outrunner-preview" : "outrunner-preview";
}

/** A request path the proxy will send on: origin-form (`/…`), never an
 *  absolute URL, which would name another host. */
export function isOriginFormPath(url: string | undefined): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//");
}

/** A path to bring a visitor back to after signing in: on the preview's
 *  own host, a path and query, or the root. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !isOriginFormPath(value) || value.startsWith("/\\") || value.startsWith(PREVIEW_PATH_PREFIX)) return "/";
  return value.length > 2048 ? "/" : value;
}
