import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { planFor } from "@/lib/billing/entitlements";
import { allowsBoxSize } from "@/lib/billing/plans";
import {
  clearDaytonaKey,
  clearModalToken,
  getSandboxSettings,
  setBoxSize,
  setDaytonaKey,
  setModalToken,
  setSandboxChoice,
  type SandboxChoice,
} from "@/lib/db/credentials";
import { boxSize, isBoxSizeId } from "@/lib/runtime/box-sizes";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { daytonaAcceptsKey } from "@/lib/runtime/sandbox/daytona";
import { modalAcceptsToken, type ModalToken } from "@/lib/runtime/sandbox/modal";

/**
 * Where the user's cloud sessions run (Settings → Sandbox): Outrunner's
 * sandboxes, or their own Daytona or Modal on their key. GET returns the
 * choice and whether each key is stored (its last 4 characters), never a key.
 * PUT sets the choice and, with `daytonaKey` or `modalToken`, stores a key the
 * provider has accepted; with `boxSize`, the size of new sandboxes (one beyond
 * their plan only on their own Modal, which they pay for). DELETE
 * forgets a key (`?key=daytona|modal`), which moves new sessions back to
 * Outrunner's sandboxes if they ran there.
 */

const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 500;
const CHOICES: readonly SandboxChoice[] = ["outrunner", "daytona", "modal"];
/** A Modal token's id and secret, as Modal → Settings → API Tokens shows them. */
const MODAL_TOKEN_ID = /^ak-[A-Za-z0-9]{8,100}$/;
const MODAL_TOKEN_SECRET = /^as-[A-Za-z0-9]{8,100}$/;

/** The token in a PUT's `modalToken`, if it is shaped like one. */
function modalTokenIn(value: unknown): ModalToken | null {
  if (!value || typeof value !== "object") return null;
  const { tokenId, tokenSecret } = value as Record<string, unknown>;
  const id = typeof tokenId === "string" ? tokenId.trim() : "";
  const secret = typeof tokenSecret === "string" ? tokenSecret.trim() : "";
  return MODAL_TOKEN_ID.test(id) && MODAL_TOKEN_SECRET.test(secret) ? { tokenId: id, tokenSecret: secret } : null;
}

function invalid(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** Run a save, answering the database's refusal as JSON the page can show. */
function saving(save: () => Promise<NextResponse>): Promise<NextResponse> {
  return savingSettings("sandbox settings", save);
}

export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return NextResponse.json(await getSandboxSettings(owner.id));
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();

  let body: { sandbox?: unknown; daytonaKey?: unknown; modalToken?: unknown; boxSize?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return invalid("Expected a JSON body.");
  }
  const sandbox = CHOICES.find((c) => c === body?.sandbox);
  if (!sandbox) return invalid("Choose Outrunner's sandbox, or your own Daytona or Modal.");
  if (body.boxSize !== undefined && !isBoxSizeId(body.boxSize)) return invalid("Choose one of the box sizes.");
  const size = isBoxSizeId(body.boxSize) ? boxSize(body.boxSize) : null;
  // A size beyond the user's plan isn't for Outrunner's sandboxes; their own
  // Modal is on their bill.
  if (size && sandbox !== "modal" && !allowsBoxSize(await planFor(owner.id), size.id)) {
    return NextResponse.json({ error: `${size.label} needs a higher plan.` }, { status: 403 });
  }

  return saving(async () => {
    if (body.daytonaKey !== undefined) {
      const key = typeof body.daytonaKey === "string" ? body.daytonaKey.trim() : "";
      if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
        return invalid("That doesn't look like a Daytona API key. Copy it from Daytona → API Keys.");
      }
      let accepted: boolean;
      try {
        accepted = await daytonaAcceptsKey(key);
      } catch (error) {
        console.error("Could not check a Daytona key", error);
        return NextResponse.json(
          { error: "Couldn't reach Daytona to check that key. Try again in a moment." },
          { status: 502 },
        );
      }
      if (!accepted) return invalid("Daytona didn't accept that key. Check it in Daytona → API Keys.");
      await setDaytonaKey(owner.id, key);
    } else if (sandbox === "daytona" && !(await getSandboxSettings(owner.id)).daytona.connected) {
      return invalid("Add your Daytona API key to run sessions on your own Daytona.");
    }

    if (body.modalToken !== undefined) {
      const token = modalTokenIn(body.modalToken);
      if (!token) {
        return invalid(
          "That doesn't look like a Modal token: an id (ak-…) and a secret (as-…), from Modal → Settings → API Tokens.",
        );
      }
      let accepted: boolean;
      try {
        accepted = await modalAcceptsToken(token);
      } catch (error) {
        console.error("Could not check a Modal token", error);
        return NextResponse.json(
          { error: "Couldn't reach Modal to check that token. Try again in a moment." },
          { status: 502 },
        );
      }
      if (!accepted) return invalid("Modal didn't accept that token. Check it in Modal → Settings → API Tokens.");
      await setModalToken(owner.id, token);
    } else if (sandbox === "modal" && !(await getSandboxSettings(owner.id)).modal.connected) {
      return invalid("Add your Modal token to run sessions on your own Modal.");
    }

    await setSandboxChoice(owner.id, sandbox);
    if (size) await setBoxSize(owner.id, size.id);
    return NextResponse.json(await getSandboxSettings(owner.id));
  });
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();

  const key = new URL(request.url).searchParams.get("key") ?? "daytona";
  if (key !== "daytona" && key !== "modal") return invalid("Say which key to remove: daytona or modal.");
  return saving(async () => {
    await (key === "modal" ? clearModalToken(owner.id) : clearDaytonaKey(owner.id));
    return NextResponse.json(await getSandboxSettings(owner.id));
  });
}
