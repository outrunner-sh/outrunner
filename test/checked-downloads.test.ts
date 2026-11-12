import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BOX_TOOL_SHA256 } from "@/lib/runtime/box-image";
import { claudeNativeInstallCommand } from "@/lib/runtime/claude-cli";
import { ghInstallCommand } from "@/lib/runtime/github-cli";

/** A box whose `curl` downloads a script that, if anything ran it, would leave
 *  a mark: what a tampered release would be. Its `uname -m` says `arch`. */
function tamperedBox(command: string, arch = "x86_64") {
  const dir = mkdtempSync(join(tmpdir(), "checked-"));
  const bin = join(dir, "bin");
  const mark = join(dir, "ran");
  spawnSync("mkdir", [bin]);
  for (const util of ["sha256sum", "mktemp", "chmod", "rm", "tar", "install", "cat"]) {
    symlinkSync(spawnSync("sh", ["-c", `command -v ${util}`], { encoding: "utf8" }).stdout.trim(), join(bin, util));
  }
  writeFileSync(join(bin, "uname"), `#!/bin/sh\necho ${arch}\n`, { mode: 0o755 });
  // Writes its payload to the path after -o.
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nprintf '#!/bin/sh\\ntouch ${mark}\\n' > "$2"\n`,
    { mode: 0o755 },
  );
  const result = spawnSync("/bin/sh", ["-c", command], {
    env: { ...process.env, PATH: bin, HOME: dir },
    encoding: "utf8",
  });
  return { ...result, ran: existsSync(mark) };
}

test("a Claude Code download that isn't the pinned build never runs", () => {
  const result = tamperedBox(claudeNativeInstallCommand());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did NOT match/);
  assert.equal(result.ran, false);
});

test("Claude Code is checked against its own architecture's sum", () => {
  const command = claudeNativeInstallCommand();
  assert.ok(command.includes(`p=linux-x64 sum=${BOX_TOOL_SHA256.claudeCode.amd64}`));
  assert.ok(command.includes(`p=linux-arm64 sum=${BOX_TOOL_SHA256.claudeCode.arm64}`));
});

test("a Claude Code install on an architecture with no build stops", () => {
  const result = tamperedBox(claudeNativeInstallCommand(), "riscv64");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /No Claude Code build for riscv64/);
});

test("a gh download that isn't the pinned release is never unpacked or installed", () => {
  for (const arch of ["x86_64", "aarch64", "riscv64"]) {
    const result = tamperedBox(ghInstallCommand({ sudo: false }), arch);
    assert.notEqual(result.status, 0, arch);
    assert.match(result.stderr, /did NOT match|no properly formatted/, arch);
    assert.equal(result.ran, false, arch);
  }
  const command = ghInstallCommand({ sudo: false });
  assert.ok(command.includes(`arch=amd64 sum=${BOX_TOOL_SHA256.gh.amd64}`));
  assert.ok(command.includes(`arch=arm64 sum=${BOX_TOOL_SHA256.gh.arm64}`));
});
