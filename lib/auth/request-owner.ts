import type { Owner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";

/** Where a request's owner can come from: the CLI's token (lib/auth/cli-owner.ts)
 *  or the browser's session (lib/auth/owner.ts). Passed in, so this tests on
 *  its own. */
export type OwnerSources = {
  cli: (request: Request) => Promise<Owner | null>;
  browser: () => Promise<Owner | null>;
};

/**
 * Who a route that serves both the page and the CLI is acting for, or the
 * answer to give instead. A request with a bearer token is the CLI's, and
 * signs in by that token alone: a browser never sends one on its own, and a
 * cross-site page can't add one without a preflight no route answers. Any
 * other request is the page's, and gets the Origin check its cookie needs.
 */
export async function ownerOfRequest(
  request: Request,
  sources: OwnerSources,
): Promise<{ owner: Owner } | { response: Response }> {
  if (/^Bearer\s/i.test(request.headers.get("authorization") ?? "")) {
    const owner = await sources.cli(request);
    return owner
      ? { owner }
      : { response: Response.json({ error: "Not signed in. Run `outrunner login`." }, { status: 401 }) };
  }
  if (!isSameOriginRequest(request)) {
    return { response: Response.json({ error: "Invalid request origin." }, { status: 403 }) };
  }
  const owner = await sources.browser();
  return owner
    ? { owner }
    : { response: Response.json({ error: "Sign in to Outrunner first." }, { status: 401 }) };
}
