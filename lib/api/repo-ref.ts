/**
 * Repositories and pull requests named by address (`repo_url`, `pr_url`), as
 * a caller that knows a repository by its URL names it, rather than by the
 * id of its Outrunner project. No network: what an address names, as a
 * project's `full_name` (lib/runtime/types.ts Project: GitHub's owner/name,
 * gitlab.com/group/project with its subgroups) and a pull request's number.
 */

export type PullRequestRef = { fullName: string; number: number };

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** The path of an address on `host`, past its scheme, user and host, or
 *  null for one on another host. Takes https URLs, bare hosts
 *  (github.com/acme/web) and SSH remotes (git@github.com:acme/web.git). */
function pathOn(value: string, host: string): string[] | null {
  const text = value.trim();
  const ssh = new RegExp(`^(?:ssh://)?git@${host.replace(".", "\\.")}[:/](.+)$`, "i").exec(text);
  let path: string;
  if (ssh) path = ssh[1];
  else {
    let url: URL;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== host) return null;
    path = url.pathname;
  }
  const parts = path.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  return parts.every((part) => SEGMENT.test(part) && part !== "." && part !== "..") ? parts : null;
}

/** The project `full_name` a repository address names, or null for one that
 *  names no GitHub or GitLab.com repository. GitHub's `owner/name` alone is
 *  one too. */
export function repoFullName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 500) return null;
  const bare = value.trim().replace(/\.git$/, "");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(bare) && !bare.includes("..") && !/^github\.com\//i.test(bare)) return bare;
  const github = pathOn(value, "github.com");
  if (github) return github.length === 2 ? github.join("/") : null;
  const gitlab = pathOn(value, "gitlab.com");
  // A group, its subgroups, then the project; never a page under it (/-/).
  if (gitlab) return gitlab.length >= 2 && !gitlab.includes("-") ? `gitlab.com/${gitlab.join("/")}` : null;
  return null;
}

/** The pull request (merge request, on GitLab) an address names, or null:
 *  github.com/acme/web/pull/12, gitlab.com/group/project/-/merge_requests/3,
 *  with any page of it after (/files, /diffs). */
export function pullRequestRef(value: unknown): PullRequestRef | null {
  if (typeof value !== "string" || value.length > 500) return null;
  const github = pathOn(value, "github.com");
  if (github && github.length >= 4 && github[2] === "pull" && /^[1-9]\d{0,9}$/.test(github[3])) {
    return { fullName: `${github[0]}/${github[1]}`, number: Number(github[3]) };
  }
  const gitlab = pathOn(value, "gitlab.com");
  const at = gitlab?.indexOf("-") ?? -1;
  if (gitlab && at >= 2 && gitlab[at + 1] === "merge_requests" && /^[1-9]\d{0,9}$/.test(gitlab[at + 2] ?? "")) {
    return { fullName: `gitlab.com/${gitlab.slice(0, at).join("/")}`, number: Number(gitlab[at + 2]) };
  }
  return null;
}

/**
 * What a session on a pull request is told before its prompt: which one,
 * and where its work goes. On its own branch (`workOnPrBranch`) it pushes to
 * the pull request's head, so its commits join that pull request; otherwise
 * it works on a branch of its own, made from that head.
 */
export function pullRequestPreamble(input: {
  url: string;
  title: string;
  baseRef: string | null;
  headRef: string;
  workOnPrBranch: boolean;
}): string {
  return [
    `You're working on this pull request: ${input.url}${input.title ? ` "${input.title}"` : ""}.`,
    `Its head branch is ${input.headRef}${input.baseRef ? `, merging into ${input.baseRef}` : ""}; your checkout starts at its head.`,
    input.workOnPrBranch
      ? `Push your commits to its head branch (\`git push origin HEAD:${input.headRef}\`), so they join this pull request. Don't open another one.`
      : `Your commits go on your own branch, made from its head. If you open a pull request, base it on ${input.headRef}.`,
  ].join("\n");
}
