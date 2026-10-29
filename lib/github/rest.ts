export type GitHubGetResult<T> = { value: T; status: number; retryable: false } | { value: null; status: number | null; retryable: boolean };

/** GET a GitHub REST path with a token, retaining the HTTP status so callers
 *  can distinguish a missing resource from a temporary GitHub failure. No
 *  server imports, so pure modules (and the test runner) can use it. */
export async function githubGetResult<T>(token: string, path: string): Promise<GitHubGetResult<T>> {
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { value: (await response.json()) as T, status: response.status, retryable: false };
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after") ||
          (typeof body?.message === "string" && /rate limit|secondary limit/i.test(body.message))));
    return {
      value: null,
      status: response.status,
      retryable: response.status === 408 || response.status >= 500 || rateLimited,
    };
  } catch {
    return { value: null, status: null, retryable: true };
  }
}

/** GET a GitHub REST path with a token; null on any failure. */
export async function githubGet<T>(token: string, path: string): Promise<T | null> {
  return (await githubGetResult<T>(token, path)).value;
}
