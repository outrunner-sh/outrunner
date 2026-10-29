import { NextResponse } from "next/server";
import { z } from "zod";

import { getOwner } from "@/lib/auth/owner";
import { getChatPreferences, saveChatPreferences } from "@/lib/db/chat-preferences";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";

const Change = z.object({ steerFollowUps: z.boolean() }).strict();

/** The user's chat preferences (Settings → Account → Chats): GET them, PUT
 *  a change. */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const preferences = await getChatPreferences(owner.id);
  return NextResponse.json({ preferences });
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const parsed = Change.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That isn't a chat setting." }, { status: 400 });
  return savingSettings("chat preferences", async () =>
    NextResponse.json({ preferences: await saveChatPreferences(owner.id, parsed.data) }),
  );
}
