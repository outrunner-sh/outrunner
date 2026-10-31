import { disconnectGcp, gcpConnection, selectGcpConnection } from "@/lib/db/gcp";
import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { planFor } from "@/lib/billing/entitlements";
import { activeOrgId } from "@/lib/orgs/server";
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
import { modalAcceptsToken } from "@/lib/runtime/sandbox/modal";
import { checkModalToken } from "@/lib/runtime/sandbox/modal-token";

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
const CHOICES: readonly SandboxChoice[] = ["outrunner", "daytona", "modal", "gcp"];

function invalid(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** Run a save, answering the database's refusal as JSON the page can show. */
function saving(save: () => Promise<NextResponse>): Promise<Response> {
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
  if (!sandbox) return invalid("Choose Outrunner, Daytona, Modal, or Google Cloud.");
  if (body.boxSize !== undefined && !isBoxSizeId(body.boxSize)) return invalid("Choose one of the box sizes.");
  const size = isBoxSizeId(body.boxSize) ? boxSize(body.boxSize) : null;
  if (sandbox === "gcp" && body.boxSize === "x-small") return invalid("Google Cloud supports Small, Medium, and Large sandboxes.");
  // A size beyond the user's plan isn't for Outrunner's sandboxes; their own
  // Modal is on their bill.
  // Within the plan of the org they're looking at (billing is the org's);
  // a box is still sized within its own org's at start (boxSizeOn).
  if (size && sandbox !== "modal" && sandbox !== "gcp" && !allowsBoxSize(await planFor(await activeOrgId().catch(() => undefined)), size.id)) {
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
      const checked = checkModalToken(body.modalToken);
      if ("error" in checked) return invalid(checked.error);
      const { token } = checked;
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

    if (sandbox === "gcp") {
      const c = await gcpConnection(owner.id);
      if (c?.state !== "connected") return invalid("Connect Google Cloud using outrunner sandbox connect gcp first.");
      const wanted = size?.id ?? (await getSandboxSettings(owner.id)).boxSize;
      await selectGcpConnection(c, wanted === "x-small" ? "small" : wanted);
    } else await setSandboxChoice(owner.id, sandbox);
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
  if (key !== "daytona" && key !== "modal" && key !== "gcp") return invalid("Say which connection to remove: daytona, modal, or gcp.");
  return saving(async () => {
    if (key === "gcp") {
      try { await disconnectGcp(owner.id); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not disconnect Google Cloud." }, { status: 409 }); }
    } else await (key === "modal" ? clearModalToken(owner.id) : clearDaytonaKey(owner.id));
    return NextResponse.json(await getSandboxSettings(owner.id));
  });
}
