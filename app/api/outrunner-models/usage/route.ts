import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { metadata, scopeKey } from "@/lib/codex/account";
import { codexStore } from "@/lib/codex/store";
import { getClaudeCredential, getProviderKey, modelMenu, outrunnerModelAllowance } from "@/lib/db/credentials";
import { activeOrgId } from "@/lib/orgs/server";
import { allowanceView } from "@/lib/openrouter/allowance";

/** Whether a session can run without Outrunner's models: on the user's own
 *  Claude, a Codex account (theirs or their org's), or a provider key
 *  (theirs, or their org's). */
async function ownAccess(userId: string, orgId: string | undefined): Promise<boolean> {
  const codex = (scope: Parameters<typeof scopeKey>[0]) => codexStore.read(scopeKey(scope)).then((row) => metadata(row).connected);
  const checks = await Promise.all([
    getClaudeCredential(userId).then((credential) => credential !== null),
    modelMenu(userId, orgId).then((menu) => menu.keys.length > 0),
    getProviderKey(userId, "openai").then((key) => key !== null),
    codex({ kind: "personal", id: userId }),
    orgId ? codex({ kind: "org", id: orgId.toLowerCase() }) : false,
  ]);
  return checks.some(Boolean);
}

/**
 * How much the signed-in user has used of their allowance on Outrunner's
 * models (`allowance`: a percentage and its state, never dollars), for the
 * sidebar's bar; null where there's no per-user allowance. Read from
 * OpenRouter on each call. Once it's spent, `ownAccess` says whether they
 * can carry on with an account or key of their own (null if that couldn't
 * be checked).
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  try {
    // The org's in a team org they're looking at (billing is the org's).
    const orgId = await activeOrgId().catch(() => undefined);
    const allowance = await outrunnerModelAllowance(owner.id, orgId);
    const view = allowance && allowanceView(allowance);
    const own =
      view?.state === "out"
        ? await ownAccess(owner.id, orgId).catch((error: unknown) => {
            console.error("Could not check a user's own model access", error);
            return null;
          })
        : null;
    return NextResponse.json({ allowance: view, ownAccess: own });
  } catch (error) {
    console.error("Could not read a user's Outrunner allowance", error);
    return NextResponse.json({ error: "Couldn't read your usage right now." }, { status: 502 });
  }
}
