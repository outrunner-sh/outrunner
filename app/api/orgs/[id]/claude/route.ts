import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit/record";
import { getOrg } from "@/lib/db/orgs";
import { orgCaller } from "@/lib/orgs/routes";
import { savingSettings } from "@/lib/http/settings-save";
import { checkClaudeToken } from "@/lib/runtime/credentials/claude-token";
import {
  clearOrgClaude,
  orgClaudeMeta,
  saveOrgClaude,
  CLAUDE_SUBSCRIPTION,
} from "@/lib/claude/store";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  return NextResponse.json(await orgClaudeMeta(id), {
    headers: { "Cache-Control": "no-store" },
  });
}
export async function PUT(request: Request, context: Context) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if ((await getOrg(id))?.personal)
    return NextResponse.json(
      {
        error:
          "Connect your personal subscription under Personal → Coding agents.",
      },
      { status: 409 },
    );
  const body = await request.json().catch(() => null);
  const checked = checkClaudeToken(body?.token);
  if ("error" in checked)
    return NextResponse.json({ error: checked.error }, { status: 400 });
  return savingSettings("organization Claude connection", async () => {
    await saveOrgClaude(id, checked.token, caller.owner.id);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "key.saved",
      resource: {
        type: "key",
        id: CLAUDE_SUBSCRIPTION,
        label: "Claude subscription",
      },
      details: { hint: checked.token.slice(-4) },
    });
    return NextResponse.json(await orgClaudeMeta(id), {
      headers: { "Cache-Control": "no-store" },
    });
  });
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  return savingSettings("organization Claude connection", async () => {
    await clearOrgClaude(id);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "key.removed",
      resource: {
        type: "key",
        id: CLAUDE_SUBSCRIPTION,
        label: "Claude subscription",
      },
    });
    return NextResponse.json({
      connected: false,
      last4: null,
      updatedAt: null,
    });
  });
}
