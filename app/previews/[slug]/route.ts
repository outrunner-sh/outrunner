import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { projectLevel } from "@/lib/db/org-access";
import { memberRole } from "@/lib/db/orgs";
import { previewBySlug, workspaceForPreview } from "@/lib/db/previews";
import { previewKey } from "@/lib/previews/gate.deps";
import { PREVIEW_PATH_PREFIX, PREVIEW_SLUG, previewDomain, previewOrigin, safeReturnPath } from "@/lib/previews/host";
import { mayView } from "@/lib/previews/resolve";
import { mintTicket } from "@/lib/previews/tokens";

type RouteContext = { params: Promise<{ slug: string }> };

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

/** A short page of the app's, for a visitor who can't go on. */
function refusal(status: number, title: string, message: string): Response {
  const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escape(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#222}` +
    `@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}a{color:inherit}</style></head>` +
    `<body><h1 style="font-size:1.25rem">${escape(title)}</h1><p>${escape(message)}</p><p><a href="/">Back to Outrunner</a></p></body></html>`;
  return new Response(html, {
    status,
    headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
  });
}

/**
 * Where a preview sends a visitor to sign in (lib/previews/proxy.ts), with
 * the path they asked for as `r`. Signed out, the app's sign-in gate
 * (proxy.ts) sends them through sign-in and back here first. Signed in, and
 * allowed to see it, they go back to the preview with a one-minute ticket
 * for it (lib/previews/tokens.ts), which its host trades for a session of
 * its own and then the page they asked for.
 */
export async function GET(request: Request, context: RouteContext) {
  const { slug } = await context.params;
  const url = new URL(request.url);
  const back = safeReturnPath(url.searchParams.get("r"));
  const owner = await getOwner();
  if (!owner) {
    const next = `/previews/${encodeURIComponent(slug)}?r=${encodeURIComponent(back)}`;
    return NextResponse.redirect(new URL(`/signin?next=${encodeURIComponent(next)}`, request.url), { headers: NO_STORE });
  }

  const domain = previewDomain();
  if (!domain) return refusal(503, "Previews are off", "This Outrunner doesn't serve previews.");
  const preview = PREVIEW_SLUG.test(slug) ? await previewBySlug(slug) : null;
  const workspace = preview ? await workspaceForPreview(preview.workspaceId) : null;
  if (!preview || !workspace) {
    return refusal(404, "No such preview", "This preview link was deleted, or never was. Ask whoever shared it for a new one.");
  }
  const isMember = async (userId: string, orgId: string) => (await memberRole(orgId, userId)) !== null;
  if (!(await mayView({ projectLevel, isMember }, owner.id, workspace))) {
    return refusal(
      403,
      "You can't open this preview",
      "It's for members of the session's org who can see its repository. Ask an admin of the org for access, or ask the session's owner to share it another way.",
    );
  }

  const ticket = mintTicket(previewKey(), slug, owner.id);
  const to = `${previewOrigin(slug, domain)}${PREVIEW_PATH_PREFIX}auth?ticket=${encodeURIComponent(ticket)}&r=${encodeURIComponent(back)}`;
  return NextResponse.redirect(to, { status: 303, headers: NO_STORE });
}
