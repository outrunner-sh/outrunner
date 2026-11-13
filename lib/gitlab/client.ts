import { gitLabPath } from "@/lib/code-providers/repository";
import type { GitLabRepository } from "@/lib/code-providers/repository";

export class GitLabError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "GitLabError";
    this.status = status;
  }
}

/** Only the fixed GitLab.com API receives a token. Redirects are refused. */
export async function gitLabRequest(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`https://gitlab.com/api/v4${path}`, {
    ...init,
    headers: { ...init.headers, "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new GitLabError("Your GitLab token expired or was revoked. Reconnect GitLab in Settings → Connections.", 409);
  if (!response.ok && response.status !== 404) throw new GitLabError("GitLab couldn't complete this request. Check your token's permissions and try again.");
  return response;
}

export async function gitLabJson<T>(response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch { throw new GitLabError("GitLab returned an unreadable response. Try again."); }
}

export async function gitLabUser(token: string): Promise<{ id: number; username: string }> {
  const response = await gitLabRequest(token, "/user");
  const user = await gitLabJson<{ id?: number; username?: string }>(response);
  if (!Number.isSafeInteger(user.id) || !user.username) throw new GitLabError("GitLab could not verify this token.");
  return { id: user.id!, username: user.username };
}

type ApiProject = {
  id: number; path_with_namespace: string; path: string; default_branch: string | null;
  visibility: string; description: string | null; last_activity_at: string | null;
};

function repository(project: ApiProject): GitLabRepository {
  if (!Number.isSafeInteger(project.id) || project.id <= 0) throw new GitLabError("GitLab returned an invalid project.");
  const path = gitLabPath(project.path_with_namespace);
  return {
    provider: "gitlab", repositoryId: project.id, githubRepoId: null,
    fullName: `gitlab.com/${path}`, owner: path.slice(0, path.lastIndexOf("/")), name: project.path,
    ownerType: null, avatarUrl: null, defaultBranch: project.default_branch ?? "main",
    private: project.visibility !== "public", description: project.description, language: null,
    htmlUrl: `https://gitlab.com/${path}`, pushedAt: project.last_activity_at,
  };
}

export async function listGitLabRepositories(token: string): Promise<{ repositories: GitLabRepository[]; complete: boolean }> {
  const repositories: GitLabRepository[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await gitLabRequest(token, `/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=100&page=${page}`);
    const projects = await gitLabJson<ApiProject[]>(response);
    if (!Array.isArray(projects)) throw new GitLabError("GitLab returned an invalid project list.");
    repositories.push(...projects.map(repository));
    if (!response.headers.get("x-next-page") && projects.length < 100) return { repositories, complete: true };
    if (response.headers.get("x-next-page") === "") return { repositories, complete: true };
  }
  return { repositories, complete: false };
}

export async function getGitLabRepository(token: string, ref: number | string): Promise<GitLabRepository | null> {
  const id = typeof ref === "number" ? String(ref) : encodeURIComponent(gitLabPath(ref));
  const response = await gitLabRequest(token, `/projects/${id}`);
  return response.status === 404 ? null : repository(await gitLabJson<ApiProject>(response));
}

export function gitLabErrorResponse(error: unknown): Response {
  if (error instanceof GitLabError) return Response.json({ error: error.message, settingsHref: "/settings/connections" }, { status: error.status });
  console.error("GitLab request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "Could not reach GitLab. Try again." }, { status: 502 });
}
