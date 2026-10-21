import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import {
  deleteClaudeToken,
  getClaudeTokenMeta,
  setClaudeToken,
  type ClaudeTokenMeta,
} from "@/lib/runtime/credentials/claude-credentials";

/**
 * Per-user Claude Code credential. The owner stores a `claude setup-token`
 * OAuth token so their sandboxes run on their own subscription.
 *
 * GET returns only presence + last-4 metadata; the token itself is never
 * returned once stored. Validation is deliberately lazy (format-only here) —
 * an invalid token surfaces at sandbox launch, not on save.
 */

// setup-token output is an opaque OAuth token; keep the check permissive so a
// format change upstream never blocks a valid token — just guard obvious junk.
const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 500;

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

  const raw = (body as { token?: unknown })?.token;
  const token = typeof raw === "string" ? raw.trim() : "";
  if (
    token.length < MIN_TOKEN_LENGTH ||
    token.length > MAX_TOKEN_LENGTH ||
    /\s/.test(token)
  ) {
    return NextResponse.json(
      { error: "That doesn't look like a Claude token. Paste the value from `claude setup-token`." },
      { status: 400 },
    );
  }

  // An API key is the Anthropic provider's (lib/providers/claude-slot.ts).
  if (token.startsWith("sk-ant-api")) {
    return NextResponse.json(
      { error: "That's an Anthropic API key. Add it in Settings → Providers → Anthropic; this is for your Claude subscription." },
      { status: 400 },
    );
  }

  try {
    await setClaudeToken(owner.id, token);
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
    return { connected: true, last4: token.slice(-4) };
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
