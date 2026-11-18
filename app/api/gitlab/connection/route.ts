import { getOwner } from "@/lib/auth/owner";
import { deleteGitLabConnection, gitLabConnection, saveGitLabConnection } from "@/lib/db/gitlab-connections";
import { gitLabErrorResponse, gitLabUser } from "@/lib/gitlab/client";
import { isSameOriginRequest } from "@/lib/http/guards";
import { readTokenBody } from "@/lib/http/token-body";

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
  const token = await readTokenBody(request, "a GitLab personal access token");
  if (token instanceof Response) return token;
  try {
    const user = await gitLabUser(token);
    await saveGitLabConnection(owner.id, token, user);
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
