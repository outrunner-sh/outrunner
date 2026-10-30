import { boundedBody } from "@/lib/codex/body";
import { getCliOwner } from "@/lib/auth/cli-owner";
import { manageCodex } from "@/lib/codex/manage";

async function connection(request: Request) {
  const owner = await getCliOwner(request);
  if (!owner)
    return Response.json(
      { error: "Not signed in. Run `outrunner login`." },
      { status: 401 },
    );
  let body: unknown;
  if (["POST", "PUT"].includes(request.method)) {
    const raw = await boundedBody(request, 64 * 1024);
    if (!raw)
      return Response.json({ error: "Login too large." }, { status: 413 });
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      body = null;
    }
  }
  return manageCodex(
    request,
    owner,
    new URL(request.url).searchParams.get("org"),
    body,
  );
}
export const GET = connection;
export const POST = connection;
export const PUT = connection;
