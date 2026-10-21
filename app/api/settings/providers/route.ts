import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { clearProviderKey, getProviderKeyStatuses, setProviderKey, settleClaudeSlot } from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { keySource } from "@/lib/openrouter/keys";
import { checkProviderKey } from "@/lib/providers/check";
import { isKeyProviderId, type KeyProviderId, keyProblem, PROVIDERS } from "@/lib/providers/registry";

/**
 * The user's own keys for model providers, and the agents' API keys
 * (Settings → Providers, lib/providers/registry.ts). GET says which providers have one (their last 4
 * characters, never the key). PUT stores a key its provider has accepted;
 * DELETE forgets one.
 */

async function providers(userId: string) {
  const keys = await getProviderKeyStatuses(userId);
  // `openrouter` and `serverModels` are what a page from before the other
  // providers reads back after a save; kept for one release, or it breaks.
  return { keys, openrouter: keys.openrouter, serverModels: keySource() !== null };
}

/** Run a change, answering the database's refusal as JSON the page can show. */
function changing(change: () => Promise<NextResponse>): Promise<NextResponse> {
  return savingSettings("provider settings", change);
}

export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return changing(async () => {
    await settleClaudeSlot(owner.id); // see app/settings/providers/page.tsx
    return NextResponse.json(await providers(owner.id));
  });
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();

  const body = (await request.json().catch(() => null)) as
    | { provider?: unknown; key?: unknown; openrouterKey?: unknown }
    | null;
  // `openrouterKey` is how a page from before the other providers saves one;
  // kept for one release.
  const legacy = body?.provider === undefined && typeof body?.openrouterKey === "string";
  const provider: unknown = legacy ? "openrouter" : body?.provider;
  const raw = legacy ? body?.openrouterKey : body?.key;
  if (!isKeyProviderId(provider)) {
    return NextResponse.json({ error: "Choose one of the providers." }, { status: 400 });
  }
  const key = typeof raw === "string" ? raw.trim() : "";
  const problem = keyProblem(provider, key);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const { label, keysPage } = PROVIDERS[provider];
  let check;
  try {
    check = await checkProviderKey(provider, key);
  } catch (error) {
    console.error(`Could not check a ${label} key`, error);
    return NextResponse.json(
      { error: `Couldn't reach ${label} to check that key. Try again in a moment.` },
      { status: 502 },
    );
  }
  if (!check.accepted) {
    return NextResponse.json(
      {
        error:
          provider === "openrouter"
            ? "OpenRouter didn't accept that as an API key. Use a key from OpenRouter → Keys, not a management key."
            : `${label} didn't accept that key. Copy a new one from ${keysPage}.`,
      },
      { status: 400 },
    );
  }
  return changing(async () => {
    await setProviderKey(owner.id, provider, key);
    return NextResponse.json({ ...(await providers(owner.id)), warning: check.warning ?? null });
  });
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  // No provider named: a page from before the other providers, removing its
  // OpenRouter key. Kept for one release.
  const named = new URL(request.url).searchParams.get("provider");
  const provider: KeyProviderId | null = named === null ? "openrouter" : isKeyProviderId(named) ? named : null;
  if (!provider) return NextResponse.json({ error: "Choose one of the providers." }, { status: 400 });
  return changing(async () => {
    await clearProviderKey(owner.id, provider);
    return NextResponse.json(await providers(owner.id));
  });
}
