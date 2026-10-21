import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { createAttachment } from "@/lib/db/attachments";
import { isSameOriginRequest } from "@/lib/http/guards";
import { MAX_ATTACHMENT_BYTES } from "@/lib/runtime/attachments";

/**
 * Upload one file to send with a prompt.
 *
 * Uploading is separate from sending because the home composer creates its
 * workspace by sending — the file has to exist before there is anywhere to put
 * it. The response's `id` is what the composer passes along with the prompt.
 *
 * No type allowlist: Claude runs on the box with ordinary filesystem access, so
 * whatever lands there it can open with its own tools. The size cap is the real
 * limit — one paste should not fill a 3 GiB box or stall a provision.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to attach files." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
    return NextResponse.json(
      { error: `Attachments are limited to ${mb} MB.` },
      { status: 413 },
    );
  }

  try {
    const attachment = await createAttachment(owner.id, {
      name: file.name,
      type: file.type,
      size: file.size,
      bytes: await file.arrayBuffer(),
    });
    return NextResponse.json({ attachment }, { status: 201 });
  } catch (error) {
    console.error(`Attachment upload failed for ${owner.id}`, error);
    return NextResponse.json(
      { error: "Could not upload that file. Please try again." },
      { status: 500 },
    );
  }
}
