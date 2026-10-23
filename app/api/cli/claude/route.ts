import { NextResponse } from "next/server";

import { getCliOwner } from "@/lib/auth/cli-owner";
import { getClaudeTokenMeta, setClaudeToken } from "@/lib/runtime/credentials/claude-credentials";
import { checkClaudeToken } from "@/lib/runtime/credentials/claude-token";

/**
 * `outrunner claude`: the CLI's door to the same Claude subscription slot as
 * Settings → Claude (/api/settings/claude), signed in by the CLI's token
 * rather than the browser's cookie. GET says whether one is connected (never
 * the token); PUT saves the token `claude setup-token` printed on the user's
 * computer.
 */

function signInFirst() {
  return NextResponse.json({ error: "Not signed in. Run `outrunner login`." }, { status: 401 });
}

export async function GET(request: Request) {
  const owner = await getCliOwner(request);
  if (!owner) return signInFirst();
  return NextResponse.json(await getClaudeTokenMeta(owner.id));
}

export async function PUT(request: Request) {
  const owner = await getCliOwner(request);
  if (!owner) return signInFirst();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const checked = checkClaudeToken((body as { token?: unknown })?.token);
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });

  await setClaudeToken(owner.id, checked.token);
  return NextResponse.json(await getClaudeTokenMeta(owner.id));
}
