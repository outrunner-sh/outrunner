/**
 * Environment for the short-lived clone/push operation only — never a Claude
 * job. The token is the signed-in user's own GitHub credential, passed in by
 * the route rather than read from a server-wide env var, so repository work
 * runs as that user.
 */
export function workspaceCloneEnvironment(
  githubToken: string | undefined,
): Record<string, string> {
  return githubToken ? { GITHUB_PAT: githubToken } : {};
}
