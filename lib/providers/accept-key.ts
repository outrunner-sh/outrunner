/**
 * A provider key as a settings route receives it: in the right shape for
 * its provider (keyProblem), then accepted by the provider itself
 * (checkProviderKey). For Settings → Providers and Settings → Org → Keys.
 */

import { NextResponse } from "next/server";

import { checkProviderKey } from "@/lib/providers/check";
import { type KeyProviderId, keyProblem, PROVIDERS } from "@/lib/providers/registry";

/** The key, trimmed, and what the provider warned of; or the answer to give. */
export async function acceptedKey(
  provider: KeyProviderId,
  raw: unknown,
): Promise<{ key: string; warning: string | null } | Response> {
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
  return { key, warning: check.warning ?? null };
}
