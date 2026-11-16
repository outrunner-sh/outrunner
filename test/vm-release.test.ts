import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const previousSha = "1".repeat(40);
const nextSha = "2".repeat(40);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "outrunner-vm-release-"));
  const root = join(dir, "app");
  const commands = join(dir, "commands");
  mkdirSync(commands);
  for (const sha of [previousSha, nextSha]) {
    const release = join(root, "releases", sha);
    for (const file of ["deploy/vm/compose.yml", ".image-built", ".env.build"]) {
      mkdirSync(join(release, file, ".."), { recursive: true });
      writeFileSync(join(release, file), file === ".env.build" ? `OUTRUNNER_BUILD=${sha}\n` : file === ".image-built" ? `${sha}\n` : "fixture");
    }
  }
  symlinkSync(join(root, "releases", previousSha), join(root, "current"));
  const helper = join(dir, "activate.sh");
  writeFileSync(helper, readFileSync("deploy/vm/activate-release.sh", "utf8").replaceAll("/opt/outrunner", root));
  writeFileSync(join(commands, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$VM_TEST_LOG"\nif [ "$VM_TEST_RESTART_FAILS" = 1 ] && [ "$(readlink "$VM_TEST_ROOT/current")" = "$VM_TEST_ROOT/releases/' + nextSha + '" ]; then exit 1; fi\n', { mode: 0o755 });
  writeFileSync(join(commands, "curl"), '#!/bin/sh\nsha=$(basename "$(readlink "$VM_TEST_ROOT/current")")\nif [ "$VM_TEST_WRONG_BUILD" = 1 ] && [ "$sha" = "' + nextSha + '" ]; then sha=wrong; fi\nprintf \'{"ok":true,"build":"%s"}\\n\' "$sha"\n', { mode: 0o755 });
  writeFileSync(join(commands, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${commands}:${process.env.PATH}`, VM_TEST_ROOT: root, VM_TEST_LOG: join(dir, "calls") };
  return { dir, root, helper, env };
}

test("VM activation accepts only the selected healthy build", () => {
  const f = fixture();
  try {
    const output = execFileSync("bash", [f.helper, nextSha], { env: f.env, encoding: "utf8" });
    assert.match(output, /Serving/);
    assert.equal(readlinkSync(join(f.root, "current")), join(f.root, "releases", nextSha));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const reason of ["VM_TEST_RESTART_FAILS", "VM_TEST_WRONG_BUILD"]) {
  test(`VM activation restores the previous release when ${reason}`, () => {
    const f = fixture();
    try {
      const result = spawnSync("bash", [f.helper, nextSha], { env: { ...f.env, [reason]: "1" }, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Restored previous release/);
      assert.equal(readlinkSync(join(f.root, "current")), join(f.root, "releases", previousSha));
      assert.match(readFileSync(f.env.VM_TEST_LOG, "utf8"), /image inspect/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test("VM activation rejects invalid commit input before touching services", () => {
  const result = spawnSync("bash", ["deploy/vm/activate-release.sh", "../../etc"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid commit SHA/);
});
