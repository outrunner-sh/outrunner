import { NextResponse } from "next/server";

import { getCliOwner } from "@/lib/auth/cli-owner";
import { checkLabel, ClaudeAccountError } from "@/lib/claude/accounts";
import { getClaudeTokenMeta, saveClaudeAccount, setClaudeToken } from "@/lib/runtime/credentials/claude-credentials";
import { checkClaudeToken } from "@/lib/runtime/credentials/claude-token";

/**
 * `outrunner claude`: the CLI's door to the same Claude subscription slot as
 * Settings → Claude (/api/settings/claude), signed in by the CLI's token
 * rather than the browser's cookie. GET says whether one is connected (never
 * the token); PUT saves the token `claude setup-token` printed on the user's
 * computer: as the account sessions start on, or with `label`
 * (`outrunner claude --label work`) as that named account (lib/claude/accounts.ts).
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
  const input = (body ?? {}) as { token?: unknown; label?: unknown };
  const checked = checkClaudeToken(input.token);
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
  // Older CLIs send no label: the token sessions start on, as before.
  const label = input.label === undefined || input.label === "" ? null : checkLabel(input.label);
  if (label && "error" in label) return NextResponse.json({ error: label.error }, { status: 400 });

  try {
    if (label) await saveClaudeAccount(owner.id, label.label, checked.token);
    else await setClaudeToken(owner.id, checked.token);
  } catch (error) {
    if (error instanceof ClaudeAccountError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  return NextResponse.json(await getClaudeTokenMeta(owner.id));
}
