import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { deleteAttachment } from "@/lib/db/attachments";
import { isSameOriginRequest } from "@/lib/http/guards";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Remove an attachment the user took off the composer before sending.
 *
 * No ownership check here: {@link deleteAttachment} reads the row through the
 * session client first, so RLS makes another owner's id simply not exist.
 */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to manage attachments." }, { status: 401 });
  }

  const { id } = await context.params;
  try {
    await deleteAttachment(id);
    return NextResponse.json({ removed: true });
  } catch (error) {
    console.error(`Could not remove attachment ${id}`, error);
    return NextResponse.json(
      { error: "Could not remove that file. Please try again." },
      { status: 500 },
    );
  }
}
