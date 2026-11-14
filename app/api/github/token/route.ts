import { getOwner } from "@/lib/auth/owner";
import { setGithubIdentity } from "@/lib/db/credentials";
import { deleteGithubToken, saveGithubToken } from "@/lib/db/github-tokens";
import { GitHubSyncError, inspectPersonalToken } from "@/lib/github/client";
import { connectPersonalToken } from "@/lib/github/personal-token";
import { isSameOriginRequest } from "@/lib/http/guards";
import { readTokenBody } from "@/lib/http/token-body";

/**
 * Settings → Connections → GitHub → personal access token: save one GitHub
 * accepts (and work as their own account from then on), or remove it. It
 * reaches every repository the user's GitHub account can, in their personal
 * org (lib/github/repository-source.ts), with no App installed by an
 * organization's owner.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  const token = await readTokenBody(request, "a GitHub personal access token");
  if (token instanceof Response) return token;
  try {
    const saved = await connectPersonalToken(owner.id, token, {
      inspect: inspectPersonalToken,
      save: saveGithubToken,
      workAsThemselves: (userId) => setGithubIdentity(userId, "personal"),
    });
    return Response.json(saved, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof GitHubSyncError) {
      return Response.json({ error: error.message }, { status: error.status === 400 ? 400 : 502 });
    }
    console.error("Couldn't save the GitHub token", error);
    return Response.json({ error: "Couldn't save the token. Try again." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  try {
    await deleteGithubToken(owner.id);
    return Response.json({ token: null });
  } catch (error) {
    console.error("Couldn't remove the GitHub token", error);
    return Response.json({ error: "Couldn't remove the token. Try again." }, { status: 500 });
  }
}
