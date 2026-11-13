import { getOwner } from "@/lib/auth/owner";
import { gitLabPath, isGitLabRef } from "@/lib/code-providers/repository";
import { requireGitLabToken } from "@/lib/db/gitlab-connections";
import { getGitLabRepository, gitLabErrorResponse } from "@/lib/gitlab/client";
import { readCappedBody } from "@/lib/http/capped-body";
import { isSameOriginRequest } from "@/lib/http/guards";

/** The user's own token goes to their Mac for this clone only, as for GitHub. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  let fullName: unknown;
  const raw = await readCappedBody(request, 4096);
  try { fullName = raw === null ? null : JSON.parse(raw).fullName; } catch { /* invalid JSON */ }
  try {
    if (typeof fullName !== "string" || !isGitLabRef(fullName)) throw new Error("invalid");
    gitLabPath(fullName);
  } catch { return Response.json({ error: "Name a GitLab repository as gitlab.com/group/project." }, { status: 400 }); }
  try {
    const token = await requireGitLabToken(owner.id);
    if (!(await getGitLabRepository(token, fullName as string))) return Response.json({ error: "Your GitLab account cannot access this repository." }, { status: 403 });
    return Response.json({ token }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return gitLabErrorResponse(error); }
}
