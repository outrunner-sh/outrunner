import { getOwner } from "@/lib/auth/owner";
import { manageCodex } from "@/lib/codex/manage";
import { desktopCodexTicket } from "@/lib/codex/desktop-ticket";
import { isSameOriginRequest } from "@/lib/http/guards";
import { requireEnv } from "@/lib/env";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request))
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner)
    return Response.json({ error: "Sign in first." }, { status: 401 });
  const org = new URL(request.url).searchParams.get("org");
  const body = await request.json().catch(() => null);
  if (body?.action !== "begin")
    return Response.json(
      { error: "Invalid connection operation." },
      { status: 400 },
    );
  const response = await manageCodex(request, owner, org, body);
  if (!response.ok) return response;
  const data = await response.json();
  const origin = new URL(requireEnv("RUNTIME_BASE_URL")).origin;
  return Response.json(
    {
      attempt: data.attempt,
      bearer: desktopCodexTicket({
        user: owner.id,
        org,
        attempt: data.attempt,
        origin,
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
