import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BOX_FILE_MAX_BYTES,
  BOX_FILE_MISSING,
  BOX_FILE_TOO_LARGE,
  boxFileBase64,
  boxFilePath,
  boxFileReadCommand,
} from "@/lib/runtime/box-file";

test("a relative path is the worktree's; an absolute one is the box's", () => {
  assert.equal(boxFilePath(".context/tree.png", "/home/daytona/workspaces/w1"), "/home/daytona/workspaces/w1/.context/tree.png");
  assert.equal(boxFilePath("./a/../b.png", "/w/"), "/w/b.png");
  assert.equal(boxFilePath("/tmp/shot.png", "/w"), "/tmp/shot.png");
  assert.equal(boxFilePath("a\0.png", "/w"), null);
});

// The box's exec parses one command line, as sh -c does; a login shell's
// banner can land in its output ahead of the image.
function runOnBox(path: string, banner = "", env?: NodeJS.ProcessEnv): { output: string; code: number | null } {
  const run = spawnSync("sh", ["-c", `${banner ? `printf '%s' '${banner}'; ` : ""}${boxFileReadCommand(path)}`], {
    maxBuffer: 1e8,
    env,
  });
  return { output: run.stdout.toString(), code: run.status };
}

test("an image comes off the box whole, whatever its path holds and whatever else is printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "box-file-"));
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200_000, 7)]);
    const odd = join(dir, "it's a shot $(echo x).png");
    writeFileSync(odd, png);
    const read = runOnBox(odd, "Welcome to the box\n");
    assert.equal(read.code, 0);
    assert.ok(Buffer.from(boxFileBase64(read.output) ?? "", "base64").equals(png));

    mkdirSync(join(dir, "folder"));
    assert.equal(runOnBox(join(dir, "nope.png")).code, BOX_FILE_MISSING);
    assert.equal(runOnBox(join(dir, "folder")).code, BOX_FILE_MISSING);
    writeFileSync(join(dir, "big.png"), Buffer.alloc(BOX_FILE_MAX_BYTES + 1));
    assert.equal(runOnBox(join(dir, "big.png")).code, BOX_FILE_TOO_LARGE);
    // Unreadable is missing, not too large (root reads anything, so not there).
    if (process.getuid?.() !== 0) {
      writeFileSync(join(dir, "locked.png"), png);
      chmodSync(join(dir, "locked.png"), 0o000);
      assert.equal(runOnBox(join(dir, "locked.png")).code, BOX_FILE_MISSING);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output without the image's markers, or with more than base64 between them, isn't an image", () => {
  assert.equal(boxFileBase64("no markers here"), null);
  assert.equal(boxFileBase64("<<outrunner-file>>iVBO$$Rw0<</outrunner-file>>"), null);
  assert.equal(boxFileBase64("motd\n<<outrunner-file>>iVBORw0=<</outrunner-file>>"), "iVBORw0=");
});

test("a read that fails part way fails the command, not a cut-off image", () => {
  const dir = mkdtempSync(join(tmpdir(), "box-file-"));
  try {
    const image = join(dir, "a.png");
    writeFileSync(image, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1_000, 7)]));
    // A head that gives some of the file, then fails.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "head"), "#!/bin/sh\nprintf '\\211PNG'\nexit 1\n", { mode: 0o755 });
    const read = runOnBox(image, "", { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(read.code, 0);
    assert.equal(read.output.includes("<</outrunner-file>>"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
