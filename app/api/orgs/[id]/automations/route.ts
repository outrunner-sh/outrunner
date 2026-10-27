import { NextResponse } from "next/server";

import { savingAutomation } from "@/lib/automations/routes";
import { parseAutomationInput } from "@/lib/automations/rules";
import { createAutomation } from "@/lib/db/automations";
import { orgCaller } from "@/lib/orgs/routes";

/**
 * Make an automation in an org: its admins may. It runs as the admin who
 * made it (their Claude and plan), on the org's repositories it names.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;

  const parsed = parseAutomationInput(await request.json().catch(() => null), { full: true });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return savingAutomation(async () => {
    const automationId = await createAutomation(id, caller.owner.id, parsed.value);
    return NextResponse.json({ id: automationId }, { status: 201 });
  });
}
