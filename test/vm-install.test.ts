import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const sha = "3".repeat(40);
const tree = "4".repeat(40);
const image = `ghcr.io/outrunner-sh/outrunner/control-plane:tree-${tree}`;

// install-release.sh with its absolute paths moved into a temp dir. The source
// archive ships stub helpers that log their calls, so the test sees which
// helpers ran and that they came from the archive.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "outrunner-vm-install-"));
  const source = join(dir, "source");
  const log = join(dir, "calls");
  mkdirSync(join(source, "deploy/vm"), { recursive: true });
  for (const helper of ["build-release.sh", "activate-release.sh", "prune-releases.sh"]) {
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
  // A docker that logs its calls, the token it signs in with read from stdin.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
if [ "$1" = login ]; then echo "docker login $* token=$(cat)" >> "${log}"; exit 0; fi
echo "docker $*" >> "${log}"
case "$1" in pull) [ "$VM_TEST_PULL_FAILS" = 1 ] && exit 1 ;; esac
exit 0
`, { mode: 0o755 });
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra });
  const run = () => spawnSync("bash", [script, archive, sha], { encoding: "utf8", env: env() });
  const pull = (extra: Record<string, string> = {}, args = [image, tree]) =>
    spawnSync("bash", [script, "--pull", ...args, archive, sha], { encoding: "utf8", input: "registry-token\n", env: env(extra) });
  const calls = () => readFileSync(log, "utf8").trim().split("\n");
  return { dir, etc, run, pull, calls, release: join(dir, "opt/releases", sha) };
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
      `prune-releases.sh  domain=app.example.test`,
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
    assert.equal(f.calls().at(-2), `activate-release.sh ${sha} domain=`);
    assert.equal(f.calls().at(-1), "prune-releases.sh  domain=");
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

test("VM install pulls the tree's image as the release, then activates and prunes", () => {
  const f = fixture();
  try {
    const result = f.pull();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.release, ".env.build"), "utf8"),
      `OUTRUNNER_BUILD=${sha}\nOUTRUNNER_TREE=${tree}\nAPP_DOMAIN=app.example.test\n`);
    assert.equal(readFileSync(join(f.release, ".image-built"), "utf8"), `${sha}\n`);
    const calls = f.calls();
    // Signed in with the token from stdin, never on a command line.
    assert.match(calls[0], /^docker login .*--password-stdin token=registry-token$/);
    assert.equal(calls.filter((call) => call.includes("registry-token")).length, 1);
    assert.deepEqual(calls.slice(1), [
      `docker pull --quiet ${image}`,
      `docker tag ${image} outrunner-control-plane:${sha}`,
      `docker image rm ${image}`,
      `activate-release.sh ${sha} domain=`,
      "prune-releases.sh  domain=",
    ]);
    assert.equal(calls.some((call) => call.startsWith("build-release.sh")), false, "nothing is built on the VM");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("VM install leaves production alone when the pull fails", () => {
  const f = fixture();
  try {
    const result = f.pull({ VM_TEST_PULL_FAILS: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(f.calls().some((call) => call.startsWith("activate-release.sh")), false);
    assert.equal(spawnSync("test", ["-e", join(f.release, ".image-built")]).status, 1, "a release half made is made again next time");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("VM install refuses an image that isn't the tree's", () => {
  const f = fixture();
  try {
    const result = f.pull({}, [image.replace(tree, "5".repeat(40)), tree]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Image and tree don't match/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
