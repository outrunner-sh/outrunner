/**
 * A commit's CI as the Outrunner GitHub App reads it: its check runs (Checks:
 * read), and a failed GitHub Actions job's log (Actions: read), for the
 * follow-up that asks a session to fix what failed (lib/github/followups.ts).
 * Each takes its token and its fetch, for the tests.
 */

const API = "https://api.github.com";

type Fetch = typeof fetch;

/** A check run, as much of it as a follow-up says. */
export type CheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  /** The App that ran it: `github-actions` for a workflow's job. */
  app: string | null;
  output: { title: string | null; summary: string | null; text: string | null };
};

type ApiCheckRun = {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
};

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "outrunner",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** The latest check runs on a commit, up to 100 (one page). */
export async function commitCheckRuns(token: string, repoFullName: string, sha: string, doFetch: Fetch = fetch): Promise<CheckRun[]> {
  const response = await doFetch(`${API}/repos/${repoFullName}/commits/${sha}/check-runs?filter=latest&per_page=100`, {
    headers: headers(token),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} reading ${repoFullName}@${sha.slice(0, 7)}'s checks`);
  const data = (await response.json()) as { check_runs?: ApiCheckRun[] };
  return (data.check_runs ?? []).map((r) => ({
    id: r.id,
    name: r.name ?? `check ${r.id}`,
    status: r.status ?? "completed",
    conclusion: r.conclusion ?? null,
    url: r.html_url ?? r.details_url ?? null,
    app: r.app?.slug ?? null,
    output: { title: r.output?.title ?? null, summary: r.output?.summary ?? null, text: r.output?.text ?? null },
  }));
}

/** A job's log is read up to this much, and its end kept: a log can run to
 *  many megabytes, and what failed is near its end. */
const LOG_READ_MAX = 2 * 1024 * 1024;

/**
 * The end of a GitHub Actions job's log (a workflow's check run is its job,
 * by the same id); null when it can't be read. GitHub answers with a
 * redirect to the log's storage, which fetch follows without the token.
 */
export async function jobLogTail(token: string, repoFullName: string, jobId: number, doFetch: Fetch = fetch): Promise<string | null> {
  try {
    const response = await doFetch(`${API}/repos/${repoFullName}/actions/jobs/${jobId}/logs`, {
      headers: headers(token),
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      // Only the end is wanted: what's well before it is let go.
      while (size - (chunks[0]?.byteLength ?? 0) > LOG_READ_MAX) size -= chunks.shift()!.byteLength;
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}
