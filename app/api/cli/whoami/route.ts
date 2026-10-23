import { NextResponse } from "next/server";

import { getCliOwner } from "@/lib/auth/cli-owner";

/** Who the CLI's token signs in (`outrunner whoami`). */
export async function GET(request: Request) {
  const owner = await getCliOwner(request);
  if (!owner) {
    return NextResponse.json({ error: "Not signed in. Run `outrunner login`." }, { status: 401 });
  }
  return NextResponse.json({ login: owner.githubLogin, name: owner.name, email: owner.email });
}
