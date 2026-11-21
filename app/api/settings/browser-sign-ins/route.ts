import { NextResponse } from "next/server";
import { z } from "zod";

import { forgetSignIns, keepsSignIns, listSignIns, setKeepSignIns } from "@/lib/browser-sign-ins/sign-ins.deps";
import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";

const Change = z.object({ keep: z.boolean() }).strict();
const Project = z.string().uuid();

/**
 * The person's desktop-browser sign-ins, kept between their sessions in a
 * project (Settings → Sandbox; lib/browser-sign-ins/sign-ins.ts). GET whether
 * they're kept and the projects they're kept for, with the sites in each
 * (never a value); PUT `{ keep }` turns keeping them on or off, off deleting
 * them; DELETE forgets them, one project's with `?project=<id>`, else all.
 * Only ever the signed-in person's own.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const keep = await keepsSignIns(owner.id);
  return NextResponse.json({
    available: keep !== null,
    keep: keep === true,
    saved: keep === null ? [] : await listSignIns(owner.id),
  });
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const parsed = Change.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Say whether to keep them." }, { status: 400 });
  return savingSettings("browser sign-ins", async () => {
    await setKeepSignIns(owner.id, parsed.data.keep);
    return NextResponse.json({ available: true, keep: parsed.data.keep, saved: await listSignIns(owner.id) });
  });
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const raw = new URL(request.url).searchParams.get("project");
  const project = raw === null ? undefined : Project.safeParse(raw);
  if (project && !project.success) return NextResponse.json({ error: "That isn't a project." }, { status: 400 });
  return savingSettings("browser sign-ins", async () => {
    await forgetSignIns(owner.id, project?.data);
    return NextResponse.json({ saved: await listSignIns(owner.id) });
  });
}
