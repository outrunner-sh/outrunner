import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import {
  deleteClaudeToken,
  getClaudeTokenMeta,
  setClaudeToken,
  type ClaudeTokenMeta,
} from "@/lib/runtime/credentials/claude-credentials";
import { checkClaudeToken } from "@/lib/runtime/credentials/claude-token";

/**
 * Per-user Claude Code credential. The owner stores a `claude setup-token`
 * OAuth token so their sandboxes run on their own subscription.
 *
 * GET returns only presence + last-4 metadata; the token itself is never
 * returned once stored. The token's check is lib/runtime/credentials/claude-token.ts.
 */

function unauthorized() {
  return NextResponse.json(
    { error: "Sign in to Outrunner first." },
    { status: 401 },
  );
}

export async function GET() {
  const owner = await getOwner();
  if (!owner) return unauthorized();

  try {
    return NextResponse.json(await getClaudeTokenMeta(owner.id));
  } catch (error) {
    console.error("Could not read the Claude token", error);
    return NextResponse.json(
      { error: "Couldn't check whether Claude is connected. Reload to try again." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const checked = checkClaudeToken((body as { token?: unknown })?.token);
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });

  try {
    await setClaudeToken(owner.id, checked.token);
  } catch (error) {
    console.error("Could not save the Claude token", error);
    return NextResponse.json(
      { error: "Couldn't save your Claude token. Try again in a moment." },
      { status: 500 },
    );
  }
  // Saved: a failed re-read must not say otherwise. What was just stored is
  // its own answer.
  const meta: ClaudeTokenMeta = await getClaudeTokenMeta(owner.id).catch((error: unknown) => {
    console.error("Could not re-read the Claude token after saving it", error);
    return { connected: true, last4: checked.token.slice(-4) };
  });
  return NextResponse.json(meta);
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return unauthorized();

  try {
    await deleteClaudeToken(owner.id);
  } catch (error) {
    console.error("Could not delete the Claude token", error);
    return NextResponse.json(
      { error: "Couldn't disconnect Claude. It's still connected; try again in a moment." },
      { status: 500 },
    );
  }
  return NextResponse.json({ connected: false, last4: null });
}
