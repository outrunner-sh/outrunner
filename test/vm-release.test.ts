import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const liveSha = "1".repeat(40);
const nextSha = "2".repeat(40);

// activate-release.sh with /opt/outrunner and /etc/outrunner moved into a temp
// dir, and fake docker / curl / sleep. The fake docker records which release
// each compose project runs; the fake curl answers a slot's port with that
// release's build, so the script's health check sees what a real slot would.
const nextTree = "3".repeat(40);

function fixture({ live, legacy, tree }: { live?: "blue" | "green"; legacy?: boolean; tree?: string }) {
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
    const releaseTree = sha === nextSha && tree ? `OUTRUNNER_TREE=${tree}\n` : "";
    writeFileSync(join(release, ".env.build"), `OUTRUNNER_BUILD=${sha}\n${releaseTree}APP_DOMAIN=app.example.test\n`);
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
tree="$(sed -n 's/^OUTRUNNER_TREE=//p' "$VM_TEST_ROOT/releases/$sha/.env.build" 2>/dev/null)"
if [ "$VM_TEST_WRONG_TREE" = 1 ]; then tree=wrong; fi
printf '{"ok":true,"build":"%s","tree":"%s"}\\n' "$sha" "$tree"
`, { mode: 0o755 });
  // What happens while the drain timer sleeps, when a test says.
  writeFileSync(join(bin, "sleep"), '#!/bin/sh\n[ -z "$VM_TEST_DURING_SLEEP" ] || sh -c "$VM_TEST_DURING_SLEEP"\nexit 0\n', { mode: 0o755 });
  // The lock is the VM's flock (Linux); the drain timer runs at once here,
  // in the foreground, where setsid -f would detach it.
  writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "setsid"), `#!/usr/bin/env bash\n[ "$1" = -f ] && shift\necho "setsid $*" >> "$VM_TEST_LOG"\nexec "$@"\n`, { mode: 0o755 });

  const script = join(dir, "activate.sh");
  writeFileSync(script, readFileSync("deploy/vm/activate-release.sh", "utf8")
    .replaceAll("/opt/outrunner", root)
    .replaceAll("/etc/outrunner", etc));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const env = (extra: Record<string, string> = {}) =>
    ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, VM_TEST_LOG: log, VM_TEST_STATE: state, VM_TEST_ROOT: root, ...extra });
  const run = (extra: Record<string, string> = {}, args = [nextSha]) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: env(extra) });
  return {
    dir, root, run, env, bin, etc, state,
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
    // The new slot is healthy before the old proxy gives up the ports, and
    // the new proxy starts before the old app's slow shutdown, not after it.
    const stopOldProxy = calls.indexOf("-p outrunner stop -t 5 caddy");
    const startProxy = calls.search(/-p outrunner-edge .* up -d caddy/);
    assert.ok(calls.indexOf("-p outrunner-blue") < stopOldProxy);
    assert.ok(stopOldProxy < startProxy);
    assert.ok(startProxy < calls.indexOf("-p outrunner down"));
    assert.equal(f.running("outrunner"), false);
    assert.equal(f.running("outrunner-edge"), true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("VM activation rejects invalid commit input before touching services", () => {
  const result = spawnSync("bash", ["deploy/vm/activate-release.sh", "../../etc"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid commit SHA/);
});

test("VM activation refuses a slot that reports the commit but not the release's tree", () => {
  const f = fixture({ live: "blue", tree: nextTree });
  try {
    const ok = f.run();
    assert.equal(ok.status, 0, ok.stderr);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
  const g = fixture({ live: "blue", tree: nextTree });
  try {
    const result = g.run({ VM_TEST_WRONG_TREE: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed its health check; live traffic was not touched/);
    assert.equal(g.liveSlot(), "blue");
  } finally { rmSync(g.dir, { recursive: true, force: true }); }
});

// The drain timer an activation leaves stops the old slot later; by then a
// newer activation may have switched back to it, or put a release there.
test("the drain timer stops the old slot only if it's still idle and still that release", () => {
  const f = fixture({ live: "blue" });
  try {
    assert.equal(f.run().status, 0);
    assert.equal(f.liveSlot(), "green");
    const stops = () => (f.calls().match(/-p outrunner-blue .*down/g) ?? []).length;
    const drain = (during: string) => {
      writeFileSync(join(f.state, "outrunner-blue"), liveSha);
      const before = stops();
      const result = f.run({ VM_TEST_DURING_SLEEP: during }, ["--drain", "blue", "90"]);
      assert.equal(result.status, 0, result.stderr);
      return stops() - before;
    };
    assert.equal(drain(`echo blue > "${join(f.root, "live-slot")}"`), 0, "switched back to: live, never stopped");
    writeFileSync(join(f.root, "live-slot"), "green\n");
    assert.equal(drain(`echo "${join(f.root, "releases", nextSha)}" > "${join(f.root, "slot-blue")}"`), 0, "another release started there: left alone");
    writeFileSync(join(f.root, "slot-blue"), join(f.root, "releases", liveSha) + "\n");
    assert.equal(drain(""), 1, "still idle, still that release: stopped");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("VM pruning keeps both slots' releases and the newest, up to five, and their images", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "outrunner-vm-prune-")));
  try {
    const root = join(dir, "opt");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const shas = Array.from({ length: 8 }, (_, i) => "abcdef12"[i].repeat(40));
    // Oldest first: release i was last activated at second i.
    shas.forEach((sha, i) => {
      const release = join(root, "releases", sha);
      mkdirSync(release, { recursive: true });
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      utimesSync(release, at, at);
    });
    // The live slot runs the newest; the other slot an old one, kept anyway.
    writeFileSync(join(root, "slot-blue"), join(root, "releases", shas[7]) + "\n");
    writeFileSync(join(root, "slot-green"), join(root, "releases", shas[0]) + "\n");
    const log = join(dir, "calls");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
    const script = join(dir, "prune.sh");
    writeFileSync(script, readFileSync("deploy/vm/prune-releases.sh", "utf8").replaceAll("/opt/outrunner", root));
    const result = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    const left = shas.filter((sha) => existsSync(join(root, "releases", sha)));
    // Both slots' (7, 0) and the three newest others (6, 5, 4): five.
    assert.deepEqual(left.sort(), [shas[0], shas[4], shas[5], shas[6], shas[7]].sort());
    const calls = readFileSync(log, "utf8");
    for (const sha of [shas[1], shas[2], shas[3]]) assert.match(calls, new RegExp(`image rm outrunner-control-plane:${sha}`));
    for (const sha of left) assert.doesNotMatch(calls, new RegExp(`image rm outrunner-control-plane:${sha}`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
