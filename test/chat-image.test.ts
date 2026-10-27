import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BOX_IMAGE_MAX_BYTES,
  boxImagePath,
  boxImageUrl,
  IMAGE_MISSING,
  IMAGE_TOO_LARGE,
  imageBase64,
  imageReadCommand,
  localImagePath,
  sniffImage,
} from "@/lib/runtime/chat-image";

test("a reply's image is read off the box when it names a path, not a URL", () => {
  assert.equal(localImagePath(".context/tree.png"), ".context/tree.png");
  assert.equal(localImagePath("/tmp/shot%201.png"), "/tmp/shot 1.png");
  assert.equal(localImagePath("file:///home/daytona/w/a.png"), "/home/daytona/w/a.png");
  // Escapes are the name's, a query or fragment isn't.
  assert.equal(localImagePath(".context/shot%23one%26two.png"), ".context/shot#one&two.png");
  assert.equal(localImagePath(".context/shot.png?v=2#top"), ".context/shot.png");
  for (const url of ["https://x.dev/a.png", "http://x/a.png", "data:image/png;base64,AA", "blob:abc", "//cdn.x/a.png", "", undefined]) {
    assert.equal(localImagePath(url), null, String(url));
  }
});

test("a relative path is the worktree's; an absolute one is the box's", () => {
  assert.equal(boxImagePath(".context/tree.png", "/home/daytona/workspaces/w1"), "/home/daytona/workspaces/w1/.context/tree.png");
  assert.equal(boxImagePath("./a/../b.png", "/w/"), "/w/b.png");
  assert.equal(boxImagePath("/tmp/shot.png", "/w"), "/tmp/shot.png");
  assert.equal(boxImagePath("a\0.png", "/w"), null);
});

test("only images' bytes pass, and never SVG", () => {
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.equal(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")), null);
  assert.equal(sniffImage(new TextEncoder().encode("#!/bin/sh")), null);
});

test("the URL carries the path as one value", () => {
  assert.equal(boxImageUrl("w1", ".context/a b&c.png"), "/api/workspaces/w1/image?path=.context%2Fa%20b%26c.png");
});

// The box's exec parses one command line, as sh -c does; a login shell's
// banner can land in its output ahead of the image.
function runOnBox(path: string, banner = ""): { output: string; code: number | null } {
  const run = spawnSync("sh", ["-c", `${banner ? `printf '%s' '${banner}'; ` : ""}${imageReadCommand(path)}`], { maxBuffer: 1e8 });
  return { output: run.stdout.toString(), code: run.status };
}

test("an image comes off the box whole, whatever its path holds and whatever else is printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-image-"));
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200_000, 7)]);
    const odd = join(dir, "it's a shot $(echo x).png");
    writeFileSync(odd, png);
    const read = runOnBox(odd, "Welcome to the box\n");
    assert.equal(read.code, 0);
    assert.ok(Buffer.from(imageBase64(read.output) ?? "", "base64").equals(png));

    mkdirSync(join(dir, "folder"));
    assert.equal(runOnBox(join(dir, "nope.png")).code, IMAGE_MISSING);
    assert.equal(runOnBox(join(dir, "folder")).code, IMAGE_MISSING);
    writeFileSync(join(dir, "big.png"), Buffer.alloc(BOX_IMAGE_MAX_BYTES + 1));
    assert.equal(runOnBox(join(dir, "big.png")).code, IMAGE_TOO_LARGE);
    // Unreadable is missing, not too large (root reads anything, so not there).
    if (process.getuid?.() !== 0) {
      writeFileSync(join(dir, "locked.png"), png);
      chmodSync(join(dir, "locked.png"), 0o000);
      assert.equal(runOnBox(join(dir, "locked.png")).code, IMAGE_MISSING);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output without the image's markers, or with more than base64 between them, isn't an image", () => {
  assert.equal(imageBase64("no markers here"), null);
  assert.equal(imageBase64("<<outrunner-image>>iVBO$$Rw0<</outrunner-image>>"), null);
  assert.equal(imageBase64("motd\n<<outrunner-image>>iVBORw0=<</outrunner-image>>"), "iVBORw0=");
});
