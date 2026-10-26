import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import type { SandboxBackend, SandboxBox } from "@/lib/runtime/sandbox/backend";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
}

/** A box whose shell and uploads are this machine's. */
function localBackend(): SandboxBackend {
  const box: SandboxBox = {
    id: "sb-1",
    io: {
      exec: async (command) => ({ stdout: execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }), exitCode: 0 }),
      launch: async () => {},
      upload: async (data, remotePath) => {
        mkdirSync(path.dirname(remotePath), { recursive: true });
        writeFileSync(remotePath, data);
      },
    },
    gitExec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    home: async () => "/home/runtime",
    agentEndpoint: async () => ({ controlBaseUrl: "", controlHeaders: {}, wsBaseUrl: "" }),
  };
  return {
    create: async () => box,
    get: async () => box,
    alive: async () => true,
    delete: async () => {},
  };
}

test("attachments stay out of the user's commits: `git add -A` stages none of them", async () => {
  const worktree = mkdtempSync(path.join(os.tmpdir(), "outrunner-worktree-"));
  dirs.push(worktree);
  git(worktree, "init", "-q");
  writeFileSync(path.join(worktree, "README.md"), "hi\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "init");

  const provider = new ComputerRuntimeProvider("user-modal", localBackend());
  await provider.writeWorkspaceAttachments("sb-1", worktree, [
    { filename: "image.png", bytes: Buffer.from("png") },
    { filename: "PR-instructions.md", bytes: Buffer.from("# PR") },
  ]);

  assert.equal(readFileSync(path.join(worktree, ".attachments", "image.png"), "utf8"), "png");
  git(worktree, "add", "-A");
  assert.equal(git(worktree, "status", "--porcelain"), "");

  // A second message writes into the same folder, still ignored.
  await provider.writeWorkspaceAttachments("sb-1", worktree, [
    { filename: "later.png", bytes: Buffer.from("png") },
  ]);
  git(worktree, "add", "-A");
  assert.equal(git(worktree, "status", "--porcelain"), "");
});
