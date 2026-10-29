import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import { appRequest, routeParams } from "@/lib/api/handler";
import { requireEnv } from "@/lib/env";
import { gateDeps } from "@/lib/previews/gate.deps";
import { resolvePreview, wakeTarget } from "@/lib/previews/resolve";
import { mintSession, SESSION_TTL_SECONDS, TicketLedger } from "@/lib/previews/tokens";
import { GATE_SECRET_ENV, GATE_SECRET_HEADER, type GateRequest, type RedeemAnswer, type WakeAnswer } from "@/lib/previews/wire";
import { actAsUserKept } from "@/lib/supabase/acting-user";

// Waking a session starts its box, as the session page's lifecycle route.
export const maxDuration = 60;

const store = globalThis as { __outrunnerPreviewTickets?: TicketLedger };
const tickets = (store.__outrunnerPreviewTickets ??= new TicketLedger());

/** Whether the call is the preview proxy's, in this same process: it alone
 *  holds the secret server.ts made at start. Anything else, from anywhere,
 *  finds no route here. */
function fromProxy(request: Request): boolean {
  const secret = process.env[GATE_SECRET_ENV];
  const given = request.headers.get(GATE_SECRET_HEADER);
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isGateRequest(body: unknown): body is GateRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.slug !== "string") return false;
  if (b.op === "redeem") return typeof b.ticket === "string";
  return (b.op === "resolve" || b.op === "wake") && (b.session === null || typeof b.session === "string");
}

/**
 * The preview proxy's questions (lib/previews/wire.ts): what to do with a
 * visitor (resolve), a ticket to trade for a session cookie (redeem), and
 * the owner's ask to wake their asleep session (wake). Loopback only.
 */
export async function POST(request: Request) {
  if (!fromProxy(request)) return new NextResponse(null, { status: 404 });
  const body: unknown = await request.json().catch(() => null);
  if (!isGateRequest(body)) return NextResponse.json({ error: "Not a gate request." }, { status: 400 });
  const deps = gateDeps();

  if (body.op === "resolve") {
    return NextResponse.json(await resolvePreview(deps, body.slug, body.session));
  }

  if (body.op === "redeem") {
    const userId = tickets.redeem(deps.key, body.ticket, body.slug);
    const answer: RedeemAnswer = userId
      ? { ok: true, cookie: mintSession(deps.key, body.slug, userId), maxAge: SESSION_TTL_SECONDS }
      : { ok: false };
    return NextResponse.json(answer);
  }

  const workspace = await wakeTarget(deps, body.slug, body.session);
  if (!workspace) return NextResponse.json({ ok: false, message: "Only the session's owner can wake it." } satisfies WakeAnswer);
  const action = workspace.status === "archived" ? "restore" : "resume";
  try {
    // As the owner, through the session page's own route: their plan's
    // limits and their box, as if they'd opened the session.
    const done = await actAsUserKept(workspace.ownerId, () =>
      lifecyclePOST(
        appRequest(requireEnv("RUNTIME_BASE_URL"), `/api/workspaces/${workspace.id}/lifecycle`, { body: { action } }),
        routeParams({ id: workspace.id }),
      ),
    );
    if (done.ok) return NextResponse.json({ ok: true } satisfies WakeAnswer);
    const refusal = (await done.json().catch(() => null)) as { error?: string } | null;
    return NextResponse.json({ ok: false, message: refusal?.error ?? "Couldn't wake the session." } satisfies WakeAnswer);
  } catch (error) {
    console.error(`Preview: couldn't wake ${workspace.id}`, error);
    return NextResponse.json({ ok: false, message: "Couldn't wake the session. Open it in Outrunner." } satisfies WakeAnswer);
  }
}
