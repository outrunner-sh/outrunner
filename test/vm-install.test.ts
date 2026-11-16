import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const sha = "3".repeat(40);

// install-release.sh with its absolute paths moved into a temp dir. The source
// archive ships stub helpers that log their calls, so the test sees which
// helpers ran and that they came from the archive.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "outrunner-vm-install-"));
  const source = join(dir, "source");
  const log = join(dir, "calls");
  mkdirSync(join(source, "deploy/vm"), { recursive: true });
  for (const helper of ["build-release.sh", "activate-release.sh"]) {
    writeFileSync(join(source, "deploy/vm", helper), `#!/bin/sh\necho "${helper} $* domain=$APP_DOMAIN" >> "${log}"\n`);
  }
  const archive = join(dir, "source.tar");
  execFileSync("tar", ["-cf", archive, "-C", source, "."]);
  const etc = join(dir, "etc");
  mkdirSync(etc);
  for (const file of ["runtime.env", "cron.env"]) writeFileSync(join(etc, file), "X=1\n");
  writeFileSync(join(etc, "build.env"), "APP_DOMAIN=app.example.test\n");
  const script = join(dir, "install.sh");
  writeFileSync(script, readFileSync("deploy/vm/install-release.sh", "utf8")
    .replaceAll("/opt/outrunner", join(dir, "opt"))
    .replaceAll("/etc/outrunner", etc)
    .replaceAll("/usr/local", join(dir, "usr")));
  const run = () => spawnSync("bash", [script, archive, sha], { encoding: "utf8" });
  const calls = () => readFileSync(log, "utf8").trim().split("\n");
  return { dir, etc, run, calls, release: join(dir, "opt/releases", sha) };
}

test("VM install builds a new release with its own helpers, then activates it", () => {
  const f = fixture();
  try {
    mkdirSync(f.release, { recursive: true });
    writeFileSync(join(f.release, "stale"), "left by an interrupted attempt");
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls(), [
      `build-release.sh ${f.release} ${sha} domain=app.example.test`,
      `activate-release.sh ${sha} domain=app.example.test`,
    ]);
    assert.equal(spawnSync("test", ["-e", join(f.release, "stale")]).status, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("VM install activates an already-built release without rebuilding", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    writeFileSync(join(f.release, ".image-built"), `${sha}\n`);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already built/);
    assert.equal(f.calls().filter((call) => call.startsWith("build-release.sh")).length, 1);
    assert.equal(f.calls().at(-1), `activate-release.sh ${sha} domain=`);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("VM install refuses to start without production configuration", () => {
  const f = fixture();
  try {
    rmSync(join(f.etc, "runtime.env"));
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing .*runtime\.env/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
