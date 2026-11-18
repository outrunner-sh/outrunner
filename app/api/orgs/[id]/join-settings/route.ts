import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getJoinViaGithub, setJoinViaGithub } from "@/lib/db/org-members";
import { getOrg } from "@/lib/db/orgs";
import { savingSettings } from "@/lib/http/settings-save";
import { orgCaller } from "@/lib/orgs/routes";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * How people join a team org without an invite (Settings → Org): `{
 * joinViaGithub }`, whether members of the GitHub organization its source
 * installation is on join at once (lib/orgs/github-join.ts). Its admins set
 * it; a personal org has no one else to let in.
 */
export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as { joinViaGithub?: unknown } | null;
  if (typeof body?.joinViaGithub !== "boolean") {
    return NextResponse.json({ error: "Say whether members of its GitHub organization may join." }, { status: 400 });
  }
  const joinViaGithub = body.joinViaGithub;
  return savingSettings("how people join the org", async () => {
    const org = await getOrg(id);
    if (!org || org.personal) {
      return NextResponse.json({ error: "A personal org is just yours: no one joins it." }, { status: 409 });
    }
    await setJoinViaGithub(id, joinViaGithub, caller.owner.id);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "org.github_join_changed",
      resource: { type: "settings", id: "join" },
      details: { joinViaGithub },
    });
    return NextResponse.json({ joinViaGithub: await getJoinViaGithub(id) });
  });
}
