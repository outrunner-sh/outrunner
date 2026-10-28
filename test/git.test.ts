import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  addWorktree,
  cloneMirror,
  syncMirrors,
  commitAll,
  fetchMirror,
  fileContent,
  gitFailureOutput,
  listChangedFiles,
  listWorktreeFiles,
  pushBranch,
  readFileDiff,
  readWorktreeFile,
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

test("gitFailureOutput returns git's own message with the token redacted", () => {
  const error = new Error(
    "git -C failed (1): To https://github.com/acme/app.git\n ! [rejected] runtime/x -> runtime/x (fetch first)\nghp_secret",
  );
  assert.equal(
    gitFailureOutput(error, ["ghp_secret"]),
    "To https://github.com/acme/app.git\n ! [rejected] runtime/x -> runtime/x (fetch first)\n***",
  );
});

test("gitFailureOutput ignores errors that aren't git's and git's silence", () => {
  assert.equal(gitFailureOutput(new Error("Box unreachable")), null);
  assert.equal(gitFailureOutput(new Error("git push failed (128): no output")), null);
  assert.equal(gitFailureOutput("git push failed (1): x"), null);
});

test("gitFailureOutput caps a long message", () => {
  const said = gitFailureOutput(new Error(`git push failed (1): ${"x".repeat(5_000)}`));
  assert.equal(said?.length, 2_001);
  assert.ok(said?.endsWith("…"));
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

test("the Files panel lists a worktree's files and reads only those inside it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "outrunner-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "repo");
  await mkdir(join(worktree, "src"), { recursive: true });
  await sh(worktree, "init", "--quiet", "-b", "main");
  await writeFile(join(worktree, "README.md"), "hello\n");
  await writeFile(join(worktree, "gone.md"), "bye\n");
  await writeFile(join(worktree, ".gitignore"), "secret.env\n");
  await sh(worktree, "add", ".");
  await sh(worktree, "commit", "--quiet", "-m", "first");
  await unlink(join(worktree, "gone.md"));
  await writeFile(join(worktree, "src", "app.ts"), "export const a = 1;\n");
  await writeFile(join(worktree, "secret.env"), "KEY=1\n");
  await writeFile(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0, 0]));
  await writeFile(join(root, "outside.txt"), "not yours\n");
  await symlink(join(root, "outside.txt"), join(worktree, "escape.txt"));
  await symlink("src/app.ts", join(worktree, "inside.ts"));

  // Tracked and untracked; not ignored, not deleted; sorted.
  assert.deepEqual(await listWorktreeFiles(realGit, { worktree }), {
    files: [".gitignore", "README.md", "escape.txt", "inside.ts", "logo.png", "src/app.ts"],
    truncated: false,
  });

  assert.deepEqual(await readWorktreeFile(realGit, { worktree, path: "src/app.ts" }), {
    content: "export const a = 1;\n",
    binary: false,
    truncated: false,
    size: 20,
  });
  assert.equal((await readWorktreeFile(realGit, { worktree, path: "inside.ts" })).content, "export const a = 1;\n");
  assert.equal((await readWorktreeFile(realGit, { worktree, path: "secret.env" })).content, "KEY=1\n");
  assert.deepEqual(await readWorktreeFile(realGit, { worktree, path: "logo.png" }), {
    content: "",
    binary: true,
    truncated: false,
    size: 4,
  });
  for (const path of ["escape.txt", "src", "gone.md", "nope.ts"]) {
    await assert.rejects(readWorktreeFile(realGit, { worktree, path }), /not found in this workspace/, path);
  }
  for (const path of ["../outside.txt", "/etc/passwd", ":(glob)*"]) {
    await assert.rejects(readWorktreeFile(realGit, { worktree, path }), /Invalid file path/, path);
  }

  // A long file comes back cut, on a character.
  await writeFile(join(worktree, "long.txt"), "✓".repeat(10));
  const long = await readWorktreeFile(realGit, { worktree, path: "long.txt", maxBytes: 7 });
  assert.deepEqual(long, { content: "✓✓", binary: false, truncated: true, size: 30 });
});

test("the Files panel lists a folder of checkouts under each one's folder", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "outrunner-checkouts-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  for (const name of ["web", "api"]) {
    const dir = join(folder, name);
    await mkdir(dir, { recursive: true });
    await sh(dir, "init", "--quiet", "-b", "main");
    await writeFile(join(dir, "README.md"), `${name}\n`);
  }
  await writeFile(join(folder, "api", "new.go"), "package api\n");

  assert.deepEqual(await listWorktreeFiles(realGit, { worktree: folder, checkouts: ["web", "api"] }), {
    files: ["api/README.md", "api/new.go", "web/README.md"],
    truncated: false,
  });
  // The folder itself is no repository: listed as one, it fails.
  await assert.rejects(listWorktreeFiles(realGit, { worktree: folder }));
  assert.equal((await readWorktreeFile(realGit, { worktree: folder, path: "api/new.go" })).content, "package api\n");
});

test("fileContent reads bytes that aren't UTF-8 as binary", () => {
  assert.equal(fileContent(Buffer.from([0xff, 0xfe, 0x61]).toString("utf8"), 3).binary, true);
  assert.equal(fileContent("plain\n", 6).binary, false);
});

test("syncMirrors fetches the mirrors a box has and clones the rest, or another repository's", async () => {
  const calls: Call[] = [];
  const exec: GitExec = async (argv, options) => {
    calls.push({ argv, options });
    // web's mirror is acme/web's; api's folder holds another repository's;
    // docs has none.
    if (argv.includes("get-url")) {
      if (argv.includes("/r/repos/web.git")) return { stdout: "https://github.com/acme/web.git\n", stderr: "", exitCode: 0 };
      if (argv.includes("/r/repos/api.git")) return { stdout: "https://github.com/old-org/api.git\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "not a git repository", exitCode: 128 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await syncMirrors(exec, {
    root: "/r/repos",
    repos: [
      { fullName: "acme/web", checkout: "web" },
      { fullName: "acme/api", checkout: "api" },
      { fullName: "acme/docs", checkout: "docs" },
    ],
    token: "t",
  });
  const shown = calls.map((c) => c.argv.join(" "));
  assert.ok(shown.some((c) => c.includes("/r/repos/web.git") && c.includes("fetch --prune origin")), shown.join("\n"));
  assert.ok(!shown.includes("git init --bare /r/repos/web.git"));
  for (const name of ["api", "docs"]) {
    assert.ok(shown.includes(`rm -rf /r/repos/${name}.git`), name);
    assert.ok(shown.includes(`git init --bare /r/repos/${name}.git`), name);
  }
});

test("syncMirrors never deletes another repository's mirror a worktree still uses", async () => {
  const calls: string[] = [];
  const exec: GitExec = async (argv) => {
    calls.push(argv.join(" "));
    if (argv.includes("get-url")) return { stdout: "https://github.com/old-org/api.git\n", stderr: "", exitCode: 0 };
    if (argv.includes("worktree")) {
      return { stdout: "worktree /r/repos/api.git\nbare\n\nworktree /r/workspaces/ws1/api\nbranch refs/heads/b\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await assert.rejects(
    syncMirrors(exec, { root: "/r/repos", repos: [{ fullName: "acme/api", checkout: "api" }] }),
    /belongs to another repository/,
  );
  assert.ok(!calls.some((c) => c.startsWith("rm ")), calls.join("\n"));
  // Stale entries are pruned before the mirror is judged in use.
  assert.ok(calls.indexOf("git -C /r/repos/api.git worktree prune") < calls.indexOf("git -C /r/repos/api.git worktree list --porcelain"));
  assert.ok(calls.includes("git -C /r/repos/api.git worktree prune"));
});
