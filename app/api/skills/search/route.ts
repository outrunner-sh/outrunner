import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { searchSkillCatalog, SkillCatalogError } from "@/lib/github/skills";
import { signInFirst } from "@/lib/http/settings-save";

/**
 * Search the skills.sh catalog, `?q=`, for a skill to enable on a project:
 * its results as the catalog ranks them, `github: false` on one Outrunner
 * can't install (it isn't kept on GitHub).
 */
export async function GET(request: Request) {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (query.length < 2 || query.length > 100) {
    return NextResponse.json({ error: "Search with 2 to 100 characters." }, { status: 400 });
  }
  try {
    return NextResponse.json({ skills: await searchSkillCatalog(query) });
  } catch (error) {
    if (error instanceof SkillCatalogError) return NextResponse.json({ error: error.message }, { status: 502 });
    throw error;
  }
}
