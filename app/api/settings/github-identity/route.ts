import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { setGithubIdentity, type GitHubIdentity } from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";

const IDENTITIES: readonly GitHubIdentity[] = ["personal", "app"];

/**
 * Who the user's sessions clone, push and open pull requests as
 * (Settings → Account; lib/github/identity.ts): `{ identity: "personal" }`,
 * their own GitHub sign-in, or `"app"`, the Outrunner GitHub App of each
 * session's org. New sessions take it at once; running ones as their box next
 * asks for a token.
 */
export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const body = (await request.json().catch(() => null)) as { identity?: unknown } | null;
  const identity = IDENTITIES.find((i) => i === body?.identity);
  if (!identity) {
    return NextResponse.json({ error: "Choose the Outrunner App or your own GitHub account." }, { status: 400 });
  }
  return savingSettings("GitHub identity", async () => {
    await setGithubIdentity(owner.id, identity);
    return NextResponse.json({ identity });
  });
}
