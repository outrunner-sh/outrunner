import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  clearDaytonaKey,
  getSandboxSettings,
  setBoxSize,
  setDaytonaKey,
  setSandboxChoice,
  type SandboxChoice,
} from "@/lib/db/credentials";
import { boxSize, isBoxSizeId } from "@/lib/runtime/box-sizes";
import { isSameOriginRequest } from "@/lib/http/guards";
import { daytonaAcceptsKey } from "@/lib/runtime/sandbox/daytona";
import { probeStatus } from "@/lib/supabase/probe";

export const dynamic = "force-dynamic";

/**
 * Where the user's cloud sessions run (Settings → Sandbox): Outrunner's
 * sandboxes, or their own Daytona on their API key. GET returns the choice and
 * whether a key is stored (its last 4 characters), never the key. PUT sets the
 * choice and, with `daytonaKey`, stores a key Daytona has accepted; with
 * `boxSize`, the size of new Outrunner sandboxes (not a locked one). DELETE
 * forgets the key, which moves new sessions back to Outrunner's sandboxes.
 */

const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 500;
const CHOICES: readonly SandboxChoice[] = ["outrunner", "daytona"];

function unauthorized() {
  return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
}

function invalid(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** Run a save, answering the database's refusal as JSON the page can show. */
async function saving(save: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await save();
  } catch (error) {
    // Before 20261013120000_user_sandbox.sql the columns aren't there.
    if (probeStatus(error as { code?: string }) === "outdated") {
      return NextResponse.json(
        { error: "This can't be saved until Outrunner's database is updated. Try again later." },
        { status: 503 },
      );
    }
    console.error("Could not save sandbox settings", error);
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }
}

export async function GET() {
  const owner = await getOwner();
  if (!owner) return unauthorized();
  return NextResponse.json(await getSandboxSettings(owner.id));
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return unauthorized();

  let body: { sandbox?: unknown; daytonaKey?: unknown; boxSize?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return invalid("Expected a JSON body.");
  }
  const sandbox = CHOICES.find((c) => c === body?.sandbox);
  if (!sandbox) return invalid("Choose Outrunner's sandbox or your own Daytona.");
  if (body.boxSize !== undefined && !isBoxSizeId(body.boxSize)) return invalid("Choose one of the box sizes.");
  const size = isBoxSizeId(body.boxSize) ? boxSize(body.boxSize) : null;
  if (size?.locked) {
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
  if (!owner) return unauthorized();

  return saving(async () => {
    await clearDaytonaKey(owner.id);
    return NextResponse.json(await getSandboxSettings(owner.id));
  });
}
