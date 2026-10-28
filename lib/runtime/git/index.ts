/**
 * The one place all Git behavior lives. Providers supply a `GitExec` capability
 * (how to run a process in their environment); every Git flow — mirror, fetch,
 * worktree, status, diff, commit, push — is implemented here exactly once.
 *
 * Design notes:
 * - Commands are argv arrays, never shell strings: no quoting, no injection.
 * - Working directory is passed as `git -C <dir>` (not the exec's cwd) so a
 *   command is self-contained regardless of how a provider spawns it.
 * - Authentication uses Git's inline credential helper with the token in the
 *   environment (`RUNTIME_GIT_TOKEN`) — never in argv, never in a temp file,
 *   never persisted in the remote URL. Works the same for a local `spawn` and a
 *   remote `sandbox.exec`.
 */

import { makeRedactor } from "@/lib/runtime/redact";
import { type ChangedFile, type FileContent, MAX_FILE_BYTES, type WorktreeFiles } from "@/lib/runtime/types";

export type GitExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitExecOptions = {
  /** Extra environment for this invocation (e.g. the credential token). */
  env?: Record<string, string>;
};

/** How a provider runs one process in its environment. */
export type GitExec = (
  argv: string[],
  options?: GitExecOptions,
) => Promise<GitExecResult>;

// ---------------------------------------------------------------------------
// Pure helpers (previously duplicated across local and modal providers)
// ---------------------------------------------------------------------------

/** Filesystem-safe worktree directory name for a branch. */
export function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** A branch name a session may be created on: plain characters only, none of
 *  the forms git refuses or a refspec could misread. */
export function isValidBranchName(branch: string): boolean {
  return (
    branch.length >= 1 &&
    branch.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith(".") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock")
  );
}

/** Reject traversal, absolute paths, and Git pathspec magic before using a
 * caller-supplied path as a Git argument. */
export function isSafeRelativePath(filePath: string): boolean {
  return (
    Boolean(filePath) &&
    !filePath.includes("\0") &&
    !filePath.startsWith("/") &&
    !filePath.startsWith(":") &&
    filePath
      .split(/[\\/]/)
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** The `git diff --name-status -z`, `git diff --numstat -z` and
 * `git ls-files --others -z` output that together make a change set. */
export type ChangeSetOutput = {
  nameStatus: string;
  numstat: string;
  untracked: string;
};

export function parseChangedFiles(output: ChangeSetOutput): ChangedFile[] {
  const counts = parseNumstat(output.numstat);
  const files: ChangedFile[] = [];
  const fields = output.nameStatus.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index];
    if (!code) continue;
    // A rename or copy ("R100", "C75") is followed by its old and new names.
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
    index += 1;
    const filePath = fields[index];
    if (!filePath) continue;
    files.push({
      path: filePath,
      // A copy leaves its original in place, so the new path is an addition.
      status:
        code.startsWith("A") || code.startsWith("C")
          ? "added"
          : code.startsWith("D")
            ? "deleted"
            : code.startsWith("R")
              ? "renamed"
              : "modified",
      additions: counts.get(filePath)?.additions ?? 0,
      deletions: counts.get(filePath)?.deletions ?? 0,
    });
  }
  // A file dropped from the index but left on disk is both a deletion and
  // untracked; list it once.
  const listed = new Set(files.map((file) => file.path));
  for (const filePath of output.untracked.split("\0")) {
    if (!filePath || listed.has(filePath)) continue;
    files.push({ path: filePath, status: "untracked", additions: 0, deletions: 0 });
  }
  return files.slice(0, 500);
}

/** How much of git's own output a user is shown: enough for a rejection's
 *  hint, not a whole hook's log. */
const GIT_OUTPUT_MAX = 2_000;

/**
 * What git itself said, from an error {@link git} threw: to show the user
 * (secrets redacted, length capped), or null when the error isn't a git
 * failure or git said nothing.
 */
export function gitFailureOutput(
  error: unknown,
  secrets: Array<string | null | undefined> = [],
): string | null {
  if (!(error instanceof Error)) return null;
  const match = /^git \S* failed \(\d+\): ([\s\S]*)$/.exec(error.message);
  if (!match) return null;
  const said = makeRedactor(secrets)(match[1]).trim();
  if (!said || said === "no output") return null;
  return said.length > GIT_OUTPUT_MAX ? `${said.slice(0, GIT_OUTPUT_MAX)}…` : said;
}

/** Line counts by path from `git diff --numstat -z`. A binary file counts "-",
 * read as 0; a rename leaves the path empty and puts its old and new names in
 * the next two fields. */
function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>();
  const fields = output.split("\0");
  const count = (value: string) => (value === "-" ? 0 : Number(value));
  for (let index = 0; index < fields.length; index += 1) {
    // A path may itself hold tabs, so only the first two separate counts.
    const [added, deleted, ...rest] = fields[index].split("\t");
    if (!/^(-|\d+)$/.test(added) || !/^(-|\d+)$/.test(deleted ?? "")) continue;
    let filePath = rest.join("\t");
    if (filePath === "") {
      index += 2;
      filePath = fields[index] ?? "";
    }
    counts.set(filePath, { additions: count(added), deletions: count(deleted) });
  }
  return counts;
}
export function limitText(value: string, maxBytes: number): string {
  return Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : `${Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8")}\n\n… diff truncated by Runtime …`;
}

// ---------------------------------------------------------------------------
// Internal command runner + auth
// ---------------------------------------------------------------------------

async function git(
  exec: GitExec,
  args: string[],
  options?: GitExecOptions,
): Promise<string> {
  const result = await exec(["git", ...args], options);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? ""} failed (${result.exitCode}): ${
        result.stderr || result.stdout || "no output"
      }`,
    );
  }
  return result.stdout;
}

/**
 * `-c` args that make Git authenticate with `x-access-token:<token>` where the
 * token comes from `RUNTIME_GIT_TOKEN` in the environment. The empty first
 * helper clears any inherited helper so only ours runs.
 */
const AUTH_CONFIG: string[] = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { test "$1" = get && echo "username=x-access-token" && echo "password=$RUNTIME_GIT_TOKEN"; }; f',
];

function authOptions(
  token: string | undefined,
  base?: GitExecOptions,
): GitExecOptions {
  if (!token) return base ?? {};
  return { env: { ...(base?.env ?? {}), RUNTIME_GIT_TOKEN: token } };
}

const remoteUrl = (repoFullName: string) =>
  `https://github.com/${repoFullName}.git`;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Full clone into `dir` (source of truth for the current local/modal flow). */
export async function cloneRepo(
  exec: GitExec,
  input: { repoFullName: string; dir: string; token?: string },
): Promise<void> {
  const remote = remoteUrl(input.repoFullName);
  await git(
    exec,
    [...AUTH_CONFIG, "clone", remote, input.dir],
    authOptions(input.token),
  );
}

/**
 * Bare mirror for the shared Runtime Computer layout (repo.git + worktrees).
 *
 * The remote's branches are kept in `refs/remotes/origin/*`, NOT local heads,
 * so a worktree can branch off `origin/<base>` and the only local `refs/heads`
 * are the per-workspace branches. `git clone --bare` puts branches directly in
 * `refs/heads` with no `origin/*`, which the agent's `worktree add … origin/<base>`
 * cannot resolve ("invalid reference") — so we init an empty bare repo, add the
 * remote (which sets the standard `+refs/heads/*:refs/remotes/origin/*` refspec
 * that `fetchMirror` then reuses), and fetch.
 */
export async function cloneMirror(
  exec: GitExec,
  input: { repoFullName: string; dir: string; token?: string },
): Promise<void> {
  const remote = remoteUrl(input.repoFullName);
  await git(exec, ["init", "--bare", input.dir]);
  await git(exec, ["-C", input.dir, "remote", "add", "origin", remote]);
  await git(
    exec,
    [
      "-C",
      input.dir,
      ...AUTH_CONFIG,
      "fetch",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ],
    authOptions(input.token),
  );
}

/** A repository's token, asked as each is reached: the App's differ per
 *  repository (lib/github/identity.ts). */
export type GitTokenFor = (fullName: string) => Promise<string | undefined>;

/** A mirror of each repository at `${root}/<checkout>.git`: fetched where one
 *  is, cloned where none is. One at a time: a box's network is the limit. */
export async function syncMirrors(
  exec: GitExec,
  input: { root: string; repos: { fullName: string; checkout: string }[]; token?: string | GitTokenFor },
): Promise<void> {
  for (const repo of input.repos) {
    const dir = `${input.root}/${repo.checkout}.git`;
    const token = typeof input.token === "function" ? await input.token(repo.fullName) : input.token;
    // A mirror the folder already holds is fetched. One of another
    // repository (removed from the project and another of the same name
    // added, or renamed on GitHub) is cloned again, but only while no
    // worktree uses it: a session's unpushed commits live in its objects.
    // None there, or half made, is cloned.
    const origin = await exec(["git", "-C", dir, "remote", "get-url", "origin"]);
    if (origin.exitCode === 0 && origin.stdout.trim() === remoteUrl(repo.fullName)) {
      await fetchMirror(exec, { repoDir: dir, token });
      continue;
    }
    if (origin.exitCode === 0) {
      // Entries whose folder went (a crash, a lost folder) don't count.
      await exec(["git", "-C", dir, "worktree", "prune"]);
      const trees = await exec(["git", "-C", dir, "worktree", "list", "--porcelain"]);
      const inUse = trees.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length > 1;
      if (trees.exitCode !== 0 || inUse) {
        throw new Error(
          `This box's ${repo.checkout} folder belongs to another repository (${origin.stdout.trim()}) that a session still uses.`,
        );
      }
    }
    await exec(["rm", "-rf", dir]);
    await cloneMirror(exec, { repoFullName: repo.fullName, dir, token });
  }
}

/** Fetch updates into a bare mirror. */
export async function fetchMirror(
  exec: GitExec,
  input: { repoDir: string; token?: string },
): Promise<void> {
  await git(
    exec,
    ["-C", input.repoDir, ...AUTH_CONFIG, "fetch", "--prune", "origin"],
    authOptions(input.token),
  );
}

/** Create a worktree on a new branch from `baseRef` (e.g. `origin/main`). */
export async function addWorktree(
  exec: GitExec,
  input: {
    repoDir: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
  },
): Promise<void> {
  await git(exec, [
    "-C",
    input.repoDir,
    "worktree",
    "add",
    "-b",
    input.branch,
    input.worktreePath,
    input.baseRef,
  ]);
}

/** Remove a worktree (and prune its administrative files). */
export async function removeWorktree(
  exec: GitExec,
  input: { repoDir: string; worktreePath: string },
): Promise<void> {
  await git(exec, [
    "-C",
    input.repoDir,
    "worktree",
    "remove",
    "--force",
    input.worktreePath,
  ]);
}

/**
 * Where a change set is measured from: the commit the branch left its base at
 * (its merge-base with `origin/<base>`, else with a local `<base>`), so work
 * already committed or pushed still shows. When no base resolves it is HEAD,
 * which leaves just the uncommitted changes.
 */
async function changeBase(
  exec: GitExec,
  worktree: string,
  baseBranch: string | undefined,
): Promise<string> {
  if (!baseBranch || !isValidBranchName(baseBranch)) return "HEAD";
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const result = await exec(["git", "-C", worktree, "merge-base", ref, "HEAD"]);
    const sha = result.stdout.trim();
    if (result.exitCode === 0 && sha) return sha;
  }
  return "HEAD";
}

async function readChangeSet(
  exec: GitExec,
  input: { worktree: string; baseBranch?: string },
): Promise<{ base: string; files: ChangedFile[] }> {
  const base = await changeBase(exec, input.worktree, input.baseBranch);
  // Against a commit, `git diff` covers staged and unstaged changes alike.
  const diff = (format: string) =>
    git(exec, [
      "-C",
      input.worktree,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      format,
      "-z",
      base,
      "--",
    ]);
  const [nameStatus, numstat, untracked] = await Promise.all([
    diff("--name-status"),
    diff("--numstat"),
    git(exec, [
      "-C",
      input.worktree,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  const files = parseChangedFiles({ nameStatus, numstat, untracked });
  await countUntrackedLines(exec, input.worktree, files);
  return { base, files };
}

/**
 * Sets each untracked file's additions to its line count, as a diff against
 * nothing would. One `git grep` counts them all: the empty pattern matches
 * every line and `-I` skips binaries, which stay at 0. The counts are a
 * nicety, so a grep that fails or matches nothing leaves them at 0.
 */
async function countUntrackedLines(
  exec: GitExec,
  worktree: string,
  files: ChangedFile[],
): Promise<void> {
  const untracked = files.filter((file) => file.status === "untracked");
  if (untracked.length === 0) return;
  const result = await exec([
    "git",
    "-C",
    worktree,
    "--literal-pathspecs",
    "grep",
    "--untracked",
    "--no-color",
    "-I",
    "-c",
    "-z",
    "-e",
    "",
    "--",
    ...untracked.map((file) => file.path),
  ]);
  if (result.exitCode !== 0) return;
  const counts = parseLineCounts(result.stdout);
  for (const file of untracked) file.additions = counts.get(file.path) ?? 0;
}

/** Line counts by path from `git grep -c -z`, which prints `path\0count\n`
 * per file. A path may hold a newline but a count cannot, so the first
 * newline after each count starts the next path. */
export function parseLineCounts(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  const fields = output.split("\0");
  let filePath = fields[0];
  for (const field of fields.slice(1)) {
    const newline = field.indexOf("\n");
    const count = newline === -1 ? field : field.slice(0, newline);
    if (filePath && /^\d+$/.test(count)) counts.set(filePath, Number(count));
    filePath = newline === -1 ? "" : field.slice(newline + 1);
  }
  return counts;
}

/** Changed files in a worktree since it left `baseBranch`, untracked included.
 * Without a base, only what is not committed yet. */
export async function listChangedFiles(
  exec: GitExec,
  input: { worktree: string; baseBranch?: string },
): Promise<ChangedFile[]> {
  return (await readChangeSet(exec, input)).files;
}

/** Bounded, text-only diff for one changed file, with membership + path safety.
 * Measured from the same base as `listChangedFiles`. */
export async function readFileDiff(
  exec: GitExec,
  input: {
    worktree: string;
    path: string;
    baseBranch?: string;
    maxBytes?: number;
  },
): Promise<string> {
  if (!isSafeRelativePath(input.path)) {
    throw new Error("Invalid changed file path");
  }
  const { base, files } = await readChangeSet(exec, input);
  const file = files.find((f) => f.path === input.path);
  if (!file) throw new Error("File is not part of this workspace change set");
  if (file.status === "untracked") {
    return "This untracked file has no Git diff yet.";
  }
  const diff = await git(exec, [
    "-C",
    input.worktree,
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    base,
    "--",
    input.path,
  ]);
  return limitText(diff, input.maxBytes ?? 200_000);
}

const MAX_LISTED_FILES = 25_000;

/** Every file in a worktree for the Files panel: tracked and untracked, not
 * the ignored ones nor those deleted from disk, sorted. Kept in step with the
 * agent's Files (runtime-agent/internal/workspace/files.go), which serves a
 * local session. */
export async function listWorktreeFiles(
  exec: GitExec,
  input: { worktree: string },
): Promise<WorktreeFiles> {
  const [listed, deleted] = await Promise.all([
    git(exec, ["-C", input.worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
    git(exec, ["-C", input.worktree, "ls-files", "--deleted", "-z"]),
  ]);
  const gone = new Set(deleted.split("\0"));
  const files = [...new Set(listed.split("\0"))].filter((path) => path && !gone.has(path)).sort();
  return { files: files.slice(0, MAX_LISTED_FILES), truncated: files.length > MAX_LISTED_FILES };
}

/** Reads one file of a worktree, its size first: a link is followed only
 * while it stays inside the worktree, and only a regular file is read. */
const READ_FILE_SCRIPT = [
  'root=$(realpath -- "$1") || exit 4',
  'file=$(realpath -- "$1/$2" 2>/dev/null) || exit 4',
  'case "$file" in "$root"/*) ;; *) exit 4 ;; esac',
  '[ -f "$file" ] || exit 4',
  'wc -c < "$file" && head -c "$3" -- "$file"',
].join("\n");

/** One worktree file's text for the Files panel, up to 512 KB; a binary one
 * comes back marked as such, without its bytes. Ignored files are not listed
 * but may still be opened. */
export async function readWorktreeFile(
  exec: GitExec,
  input: { worktree: string; path: string; maxBytes?: number },
): Promise<FileContent> {
  if (!isSafeRelativePath(input.path)) throw new Error("Invalid file path");
  const maxBytes = input.maxBytes ?? MAX_FILE_BYTES;
  const result = await exec(["sh", "-c", READ_FILE_SCRIPT, "sh", input.worktree, input.path, String(maxBytes + 1)]);
  if (result.exitCode === 4) throw new Error("File not found in this workspace");
  if (result.exitCode !== 0) throw new Error(`Could not read ${input.path}: ${result.stderr || "no output"}`);
  const newline = result.stdout.indexOf("\n");
  const size = Number(result.stdout.slice(0, newline).trim()) || 0;
  return fileContent(result.stdout.slice(newline + 1), size, maxBytes);
}

/** A file's first bytes as text, or binary when they hold a NUL or bytes that
 * aren't UTF-8, cut at `maxBytes` on a character. The exec layer hands over
 * text already decoded, so bytes that weren't UTF-8 are known only by the
 * U+FFFD they became: a valid file that holds a real U+FFFD in its first 8000
 * characters reads as binary here, where the agent's fileContent (which sees
 * the bytes) shows it. */
export function fileContent(text: string, size: number, maxBytes = MAX_FILE_BYTES): FileContent {
  const bytes = Buffer.from(text, "utf8");
  const truncated = bytes.length > maxBytes;
  // A character the cut splits decodes as U+FFFD; drop it.
  const content = truncated ? bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "") : text;
  if (/[\0\uFFFD]/.test(content.slice(0, 8000))) return { content: "", binary: true, truncated: false, size };
  return { content, binary: false, truncated, size };
}

/** `git add -A && git commit` as the given author; returns the new SHA. */
export async function commitAll(
  exec: GitExec,
  input: {
    worktree: string;
    message: string;
    author: { name: string; email: string };
  },
): Promise<{ sha: string }> {
  const env = {
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: input.author.name,
    GIT_COMMITTER_EMAIL: input.author.email,
  };
  await git(exec, ["-C", input.worktree, "add", "-A"], { env });
  await git(exec, ["-C", input.worktree, "commit", "-m", input.message], {
    env,
  });
  const sha = (
    await git(exec, ["-C", input.worktree, "rev-parse", "HEAD"])
  ).trim();
  return { sha };
}

/** Push the branch to origin using an operation-scoped token; no hooks. */
export async function pushBranch(
  exec: GitExec,
  input: {
    worktree: string;
    repoFullName: string;
    branch: string;
    token: string;
  },
): Promise<void> {
  const remote = remoteUrl(input.repoFullName);
  await git(exec, ["-C", input.worktree, "remote", "set-url", "origin", remote]);
  await git(
    exec,
    [
      "-C",
      input.worktree,
      "-c",
      "core.hooksPath=/dev/null",
      ...AUTH_CONFIG,
      "push",
      "-u",
      "origin",
      input.branch,
    ],
    authOptions(input.token),
  );
}
