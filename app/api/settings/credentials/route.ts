import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  clearAnthropicKey,
  credentialStatus,
  setAnthropicKey,
} from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's own credentials.
 *
 * Runtime runs each user's workspaces on their own Anthropic key, so this is
 * where they supply it. GitHub is not settable here — that token is captured
 * from the OAuth sign-in itself (see app/auth/callback), so this route only
 * reports whether it is connected.
 *
 * GET never returns a secret: {@link credentialStatus} yields presence plus a
 * masked hint, which is all the UI needs.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to view your settings." }, { status: 401 });
  }
  return NextResponse.json(await credentialStatus(owner.id));
}

/**
 * Both accepted credentials share this prefix: an API key (`sk-ant-api…`) and a
 * Claude Code OAuth token (`sk-ant-oat…`). Which one the user pasted decides
 * the environment variable Claude reads it from — see
 * lib/runtime/session-environment.ts.
 */
const ANTHROPIC_KEY_PREFIX = "sk-ant-";
const MAX_KEY_LENGTH = 512;

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to change your settings." }, { status: 401 });
  }

  let body: { anthropicKey?: unknown };
  try {
    body = (await request.json()) as { anthropicKey?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const key = typeof body.anthropicKey === "string" ? body.anthropicKey.trim() : "";
  if (!key) {
    return NextResponse.json({ error: "Enter your Anthropic API key." }, { status: 400 });
  }
  if (key.length > MAX_KEY_LENGTH) {
    return NextResponse.json({ error: "That key is not a valid API key." }, { status: 400 });
  }
  // Catch the common paste mistakes (a console URL, an OAuth token, a blank
  // placeholder) before they become a confusing provisioning failure later.
  if (!key.startsWith(ANTHROPIC_KEY_PREFIX)) {
    return NextResponse.json(
      {
        error: `Both an API key and a Claude Code token start with "${ANTHROPIC_KEY_PREFIX}". Check what you pasted.`,
      },
      { status: 400 },
    );
  }

  try {
    await setAnthropicKey(owner.id, key);
  } catch (error) {
    // Never echo the error: a driver message can quote the value it failed on.
    console.error(`Could not save the Anthropic key for ${owner.id}`, error);
    return NextResponse.json(
      { error: "Could not save your key. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json(await credentialStatus(owner.id));
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to change your settings." }, { status: 401 });
  }

  try {
    await clearAnthropicKey(owner.id);
  } catch (error) {
    console.error(`Could not remove the Anthropic key for ${owner.id}`, error);
    return NextResponse.json(
      { error: "Could not remove your key. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json(await credentialStatus(owner.id));
}
