import { getOwner } from "@/lib/auth/owner";
import { deleteGitLabConnection, gitLabConnection, saveGitLabConnection } from "@/lib/db/gitlab-connections";
import { gitLabErrorResponse, gitLabUser } from "@/lib/gitlab/client";
import { readCappedBody } from "@/lib/http/capped-body";
import { isSameOriginRequest } from "@/lib/http/guards";

export async function GET() {
  const owner = await getOwner();
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  try { return Response.json({ connection: await gitLabConnection(owner.id) }, { headers: { "cache-control": "no-store" } }); }
  catch (error) { return gitLabErrorResponse(error); }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  const raw = await readCappedBody(request, 4096);
  let token: unknown;
  try { token = raw === null ? null : JSON.parse(raw).token; } catch { /* invalid JSON */ }
  if (typeof token !== "string" || !token.trim() || /[\r\n\0]/.test(token)) return Response.json({ error: "Enter a GitLab personal access token." }, { status: 400 });
  try {
    const user = await gitLabUser(token.trim());
    await saveGitLabConnection(owner.id, token.trim(), user);
    return Response.json({ connection: { login: user.username, updatedAt: new Date().toISOString() } });
  } catch (error) { return gitLabErrorResponse(error); }
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  try { await deleteGitLabConnection(owner.id); return Response.json({ connection: null }); }
  catch (error) { return gitLabErrorResponse(error); }
}
