import { getOwner } from "@/lib/auth/owner";
import { manageCodex } from "@/lib/codex/manage";
import { isSameOriginRequest } from "@/lib/http/guards";
import { getOrgContext } from "@/lib/orgs/server";

async function connection(request: Request) {
  if (request.method !== "GET" && !isSameOriginRequest(request))
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner)
    return Response.json({ error: "Sign in first." }, { status: 401 });
  const url = new URL(request.url);
  if (request.method === "GET" && url.searchParams.has("scopes")) {
    const context = await getOrgContext();
    return Response.json(
      {
        user: owner.id,
        orgs: context?.orgs ?? [],
        activeOrg: context?.active.id ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const body =
    request.method === "POST"
      ? await request.json().catch(() => null)
      : undefined;
  return manageCodex(request, owner, url.searchParams.get("org"), body);
}
export const GET = connection;
export const POST = connection;
export const DELETE = connection;
