import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const liveSha = "1".repeat(40);
const nextSha = "2".repeat(40);

// activate-release.sh with /opt/outrunner and /etc/outrunner moved into a temp
// dir, and fake docker / curl / sleep. The fake docker records which release
// each compose project runs; the fake curl answers a slot's port with that
// release's build, so the script's health check sees what a real slot would.
function fixture({ live, legacy }: { live?: "blue" | "green"; legacy?: boolean }) {
  // The real path: the script refuses a release that resolves elsewhere, and
  // macOS keeps its temp folder behind a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "outrunner-vm-release-")));
  const root = join(dir, "opt");
  const etc = join(dir, "etc");
  const state = join(dir, "state");
  const bin = join(dir, "bin");
  for (const d of [etc, state, bin, join(root, "edge", "conf")]) mkdirSync(d, { recursive: true });
  for (const sha of [liveSha, nextSha]) {
    const release = join(root, "releases", sha);
    mkdirSync(join(release, "deploy", "vm"), { recursive: true });
    for (const file of ["compose.yml", "edge.yml", "jobs.yml", "Caddyfile"]) writeFileSync(join(release, "deploy", "vm", file), "fixture");
    writeFileSync(join(release, ".env.build"), `OUTRUNNER_BUILD=${sha}\nAPP_DOMAIN=app.example.test\n`);
    writeFileSync(join(release, ".image-built"), `${sha}\n`);
  }
  writeFileSync(join(etc, "cron-enabled"), "");
  if (live) {
    writeFileSync(join(root, "live-slot"), `${live}\n`);
    writeFileSync(join(root, `slot-${live}`), `${join(root, "releases", liveSha)}\n`);
    writeFileSync(join(root, "edge", "conf", "live.caddy"), `reverse_proxy app-${live}:8080\n`);
    writeFileSync(join(state, `outrunner-${live}`), liveSha);
    writeFileSync(join(state, "outrunner-edge"), "running");
  }
  if (legacy) writeFileSync(join(state, "outrunner"), "running");
  symlinkSync(join(root, "releases", liveSha), join(root, "current"));

  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
echo "$*" >> "$VM_TEST_LOG"
proj="" envf=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in -p) proj="\${args[i+1]}" ;; --env-file) envf="\${args[i+1]}" ;; esac
done
sha="$(basename "$(dirname "$envf")")"
case "$*" in
  *" up -d --no-build app"*)
    if [ "$VM_TEST_START_FAILS" = 1 ] && [ "$sha" = "${nextSha}" ]; then exit 1; fi
    echo "$sha" > "$VM_TEST_STATE/$proj" ;;
  *"caddy reload"*) [ "$VM_TEST_RELOAD_FAILS" = 1 ] && exit 1 ;;
  *" up -d caddy"*) echo running > "$VM_TEST_STATE/$proj" ;;
  *" ps -q"*) [ -f "$VM_TEST_STATE/$proj" ] && echo "$proj-id" ;;
  *" down"*) rm -f "$VM_TEST_STATE/$proj" ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
case "$*" in *:3001/*) slot=blue ;; *) slot=green ;; esac
sha="$(cat "$VM_TEST_STATE/outrunner-$slot" 2>/dev/null)" || exit 7
if [ "$VM_TEST_WRONG_BUILD" = 1 ] && [ "$sha" = "${nextSha}" ]; then sha=wrong; fi
printf '{"ok":true,"build":"%s"}\\n' "$sha"
`, { mode: 0o755 });
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const script = join(dir, "activate.sh");
  writeFileSync(script, readFileSync("deploy/vm/activate-release.sh", "utf8")
    .replaceAll("/opt/outrunner", root)
    .replaceAll("/etc/outrunner", etc));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const run = (extra: Record<string, string> = {}) => spawnSync("bash", [script, nextSha], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VM_TEST_LOG: log, VM_TEST_STATE: state, ...extra },
  });
  return {
    dir, root, run,
    calls: () => readFileSync(log, "utf8"),
    liveSlot: () => readFileSync(join(root, "live-slot"), "utf8").trim(),
    upstream: () => readFileSync(join(root, "edge", "conf", "live.caddy"), "utf8"),
    running: (proj: string) => existsSync(join(state, proj)),
  };
}

test("VM activation starts the idle slot, then switches the proxy with a reload", () => {
  const f = fixture({ live: "blue" });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.liveSlot(), "green");
    assert.match(f.upstream(), /reverse_proxy app-green:8080/);
    assert.equal(readlinkSync(join(f.root, "current")), join(f.root, "releases", nextSha));
    const calls = f.calls();
    // The proxy is reloaded in place, never restarted.
    assert.match(calls, /caddy reload/);
    assert.doesNotMatch(calls, /outrunner-edge .* up -d caddy/);
    // The new slot was healthy before the switch; the old one stops after.
    assert.ok(calls.indexOf("-p outrunner-green") < calls.indexOf("caddy reload"));
    assert.ok(calls.indexOf("caddy reload") < calls.lastIndexOf("-p outrunner-blue"));
    assert.equal(f.running("outrunner-blue"), false);
    assert.match(calls, /-p outrunner-jobs .* up -d --no-build cron/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const reason of ["VM_TEST_START_FAILS", "VM_TEST_WRONG_BUILD", "VM_TEST_RELOAD_FAILS"]) {
  test(`VM activation leaves live traffic untouched when ${reason}`, () => {
    const f = fixture({ live: "blue" });
    try {
      const result = f.run({ [reason]: "1" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /live traffic was not touched/);
      assert.equal(f.liveSlot(), "blue");
      assert.match(f.upstream(), /app-blue:8080/);
      assert.equal(readlinkSync(join(f.root, "current")), join(f.root, "releases", liveSha));
      assert.equal(f.running("outrunner-blue"), true, "the live slot keeps serving");
      assert.equal(f.running("outrunner-green"), false, "the failed slot is stopped");
      assert.doesNotMatch(f.calls(), /outrunner-jobs/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test("VM activation takes over a host on the single-project layout once", () => {
  const f = fixture({ legacy: true });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.liveSlot(), "blue");
    const calls = f.calls();
    // The new slot is healthy before the old project gives up the ports.
    assert.ok(calls.indexOf("-p outrunner-blue") < calls.indexOf("-p outrunner down"));
    assert.ok(calls.indexOf("-p outrunner down") < calls.search(/-p outrunner-edge .* up -d caddy/));
    assert.equal(f.running("outrunner"), false);
    assert.equal(f.running("outrunner-edge"), true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("VM activation rejects invalid commit input before touching services", () => {
  const result = spawnSync("bash", ["deploy/vm/activate-release.sh", "../../etc"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid commit SHA/);
});
