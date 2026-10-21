import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  addWorktree,
  cloneMirror,
  commitAll,
  fetchMirror,
  listChangedFiles,
  pushBranch,
  readFileDiff,
  type GitExec,
  type GitExecOptions,
} from "@/lib/runtime/git";

type Call = { argv: string[]; options?: GitExecOptions };

/** A GitExec that records every invocation and returns scripted stdout. */
function recorder(responses: string[] = []): { exec: GitExec; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const exec: GitExec = async (argv, options) => {
    calls.push({ argv, options });
    return { stdout: responses[i++] ?? "", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}

test("addWorktree builds an argv worktree command with -C", async () => {
  const { exec, calls } = recorder();
  await addWorktree(exec, {
    repoDir: "/r/repo",
    worktreePath: "/r/ws/x",
    branch: "feat/x",
    baseRef: "origin/main",
  });
  assert.deepEqual(calls[0].argv, [
    "git",
    "-C",
    "/r/repo",
    "worktree",
    "add",
    "-b",
    "feat/x",
    "/r/ws/x",
    "origin/main",
  ]);
});

test("pushBranch injects the token via env (never argv) and disables hooks", async () => {
  const { exec, calls } = recorder();
  await pushBranch(exec, {
    worktree: "/r/ws/x",
    repoFullName: "acme/app",
    branch: "feat/x",
    token: "ghs_secret",
  });
  // First call resets the remote; second pushes with auth.
  const push = calls[1];
  assert.ok(push.argv.includes("push"));
  assert.ok(push.argv.includes("core.hooksPath=/dev/null"));
  // The token must ride in the environment, not the argument vector.
  assert.equal(push.options?.env?.RUNTIME_GIT_TOKEN, "ghs_secret");
  assert.ok(!push.argv.some((a) => a.includes("ghs_secret")));
});

test("cloneMirror inits a bare mirror with remote-tracking refs; fetchMirror prunes", async () => {
  const clone = recorder();
  await cloneMirror(clone.exec, {
    repoFullName: "acme/app",
    dir: "/r/repo.git",
    token: "t",
  });
  // init empty bare -> add remote -> fetch into refs/remotes/origin/* (so the
  // agent can branch worktrees off origin/<base>).
  assert.deepEqual(clone.calls[0].argv, ["git", "init", "--bare", "/r/repo.git"]);
  assert.deepEqual(clone.calls[1].argv.slice(3), [
    "remote",
    "add",
    "origin",
    "https://github.com/acme/app.git",
  ]);
  const fetchCall = clone.calls[2];
  assert.ok(fetchCall.argv.includes("+refs/heads/*:refs/remotes/origin/*"));
  // Only the network fetch carries the credential token.
  assert.equal(fetchCall.options?.env?.RUNTIME_GIT_TOKEN, "t");
  assert.equal(clone.calls[0].options?.env?.RUNTIME_GIT_TOKEN, undefined);

  const fetch = recorder();
  await fetchMirror(fetch.exec, { repoDir: "/r/repo.git", token: "t" });
  assert.deepEqual(fetch.calls[0].argv.slice(-3), ["fetch", "--prune", "origin"]);
});

test("commitAll sequences add -> commit -> rev-parse with author env", async () => {
  const { exec, calls } = recorder(["", "", "abc123\n"]);
  const result = await commitAll(exec, {
    worktree: "/r/ws/x",
    message: "msg",
    author: { name: "Ada", email: "ada@x.co" },
  });
  assert.equal(result.sha, "abc123");
  // argv is ["git", "-C", <worktree>, <subcommand>, ...].
  assert.deepEqual(
    calls.map((c) => c.argv[3]),
    ["add", "commit", "rev-parse"],
  );
  assert.equal(calls[1].options?.env?.GIT_AUTHOR_NAME, "Ada");
});

test("readFileDiff rejects unsafe paths before touching git", async () => {
  const { exec, calls } = recorder();
  await assert.rejects(
    readFileDiff(exec, { worktree: "/r/ws/x", path: "../etc/passwd" }),
    /Invalid changed file path/,
  );
  assert.equal(calls.length, 0);
});

test("readFileDiff rejects a path outside the change set", async () => {
  // name-status, numstat and ls-files list only a.txt; b.txt must fail.
  const { exec } = recorder(["M\0a.txt\0", "1\t0\ta.txt\0", ""]);
  await assert.rejects(
    readFileDiff(exec, { worktree: "/r/ws/x", path: "b.txt" }),
    /not part of this workspace change set/,
  );
});

/** A GitExec running real git with no user or system config. */
const realGit: GitExec = async (argv) => {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 1,
  };
};

async function sh(dir: string, ...args: string[]): Promise<void> {
  const ident = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
  const result = await realGit(["git", "-C", dir, ...ident, ...args]);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

test("the change set spans the branch's commits and its working tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "outrunner-changes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin");
  const worktree = join(root, "clone");
  await mkdir(origin);
  await sh(origin, "init", "--quiet", "-b", "main");
  await writeFile(join(origin, "README.md"), "one\ntwo\n");
  await writeFile(join(origin, "old.ts"), "a\nb\nc\nd\n");
  await sh(origin, "add", ".");
  await sh(origin, "commit", "--quiet", "-m", "first");
  await sh(root, "clone", "--quiet", origin, worktree);
  await sh(worktree, "checkout", "--quiet", "-b", "feat/x");

  // Committed on the branch: a new file, a binary and a rename with an edit.
  await writeFile(join(worktree, "committed.ts"), "x\ny\nz\n");
  await writeFile(join(worktree, "logo.png"), Buffer.from([0, 1, 2, 0]));
  await sh(worktree, "mv", "old.ts", "new.ts");
  await writeFile(join(worktree, "new.ts"), "a\nb\nc\nD\n");
  await sh(worktree, "add", ".");
  await sh(worktree, "commit", "--quiet", "-m", "work");
  // Not committed: an edit, an untracked text file counted by its lines, and
  // an untracked binary, which stays at 0.
  await writeFile(join(worktree, "README.md"), "one\n");
  await writeFile(join(worktree, "notes.txt"), "n\no\n");
  await writeFile(join(worktree, "blob.bin"), Buffer.from([0, 10, 0, 10]));

  const rows = (files: Awaited<ReturnType<typeof listChangedFiles>>) =>
    files.map((f) => [f.path, f.status, f.additions, f.deletions]);

  const files = await listChangedFiles(realGit, { worktree, baseBranch: "main" });
  assert.deepEqual(rows(files), [
    ["README.md", "modified", 0, 1],
    ["committed.ts", "added", 3, 0],
    ["logo.png", "added", 0, 0],
    ["new.ts", "renamed", 1, 1],
    ["blob.bin", "untracked", 0, 0],
    ["notes.txt", "untracked", 2, 0],
  ]);
  // A file only the branch's commits changed still has a diff.
  const diff = await readFileDiff(realGit, {
    worktree,
    path: "committed.ts",
    baseBranch: "main",
  });
  assert.match(diff, /\+x\n\+y\n\+z/);

  // A base that does not resolve falls back to HEAD: uncommitted work only.
  const uncommitted = await listChangedFiles(realGit, {
    worktree,
    baseBranch: "no-such-branch",
  });
  assert.deepEqual(rows(uncommitted), [
    ["README.md", "modified", 0, 1],
    ["blob.bin", "untracked", 0, 0],
    ["notes.txt", "untracked", 2, 0],
  ]);
  await assert.rejects(
    readFileDiff(realGit, { worktree, path: "committed.ts", baseBranch: "no-such-branch" }),
    /not part of this workspace change set/,
  );
});
