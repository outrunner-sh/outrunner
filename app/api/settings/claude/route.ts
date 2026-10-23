import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import {
  deleteClaudeToken,
  getClaudeTokenMeta,
  setClaudeToken,
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

  const meta = await getClaudeTokenMeta(owner.id);
  return NextResponse.json(meta);
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

  await setClaudeToken(owner.id, checked.token);
  return NextResponse.json(await getClaudeTokenMeta(owner.id));
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return unauthorized();

  await deleteClaudeToken(owner.id);
  return NextResponse.json({ connected: false, last4: null });
}
