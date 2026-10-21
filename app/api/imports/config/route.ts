import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { planConfig } from "@/lib/imports/config";
import { SNAPSHOT_BUCKET } from "@/lib/runtime/storage/snapshots";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Where the desktop app uploads the archive of the user's picked setup. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const bucket = createSupabaseAdminClient().storage.from(SNAPSHOT_BUCKET);
  try {
    const upload = await planConfig(owner.id, {
      newId: () => crypto.randomUUID(),
      async mintUpload(path) {
        const { data, error } = await bucket.createSignedUploadUrl(path);
        if (error || !data) throw new Error(error?.message ?? "no upload URL");
        return data.signedUrl;
      },
    });
    return NextResponse.json({ upload });
  } catch (error) {
    console.error("Could not plan a settings import", error);
    return NextResponse.json({ error: "Could not start importing your settings. Please try again." }, { status: 502 });
  }
}
