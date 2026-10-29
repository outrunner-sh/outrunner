import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { CLAUDE_CODE_VERSION } from "@/lib/runtime/claude-cli";
import { CODEX_PACKAGE } from "@/lib/runtime/codex-cli";

import {
  AGENT_BINARY_PATH,
  AGENT_GZ_PATH,
  agentLaunchScript,
  agentPrepScript,
  bootAgent,
  claudeAgentSupervisorLaunchScript,
  claudeConfigSeedScript,
  claudeInstallScript,
  compressAgent,
  deployAgent,
  deployClaude,
  deployJcode,
  injectJcodeCreds,
  installJcode,
  jcodeAgentLaunchScript,
  jcodeBridgeScript,
  jcodePaths,
  ProvisionTimer,
  shellQuote,
  uploadAgent,
  waitForAgentHealth,
  type BoxIO,
  type ExecResult,
} from "@/lib/runtime/daytona/deploy";
import { GH_VERSION } from "@/lib/runtime/github-cli";

/** A scripted BoxIO: exec returns queued results by matching a predicate. */
function fakeBox(
  handlers: Array<{ match: (cmd: string) => boolean; result: ExecResult }>,
): {
  io: BoxIO;
  execCalls: string[];
  launchCalls: string[];
  uploads: Array<{ path: string; bytes: number }>;
} {
  const execCalls: string[] = [];
  const launchCalls: string[] = [];
  const uploads: Array<{ path: string; bytes: number }> = [];
  const io: BoxIO = {
    exec: async (command) => {
      execCalls.push(command);
      const handler = handlers.find((h) => h.match(command));
      return handler ? handler.result : { stdout: "", exitCode: 0 };
    },
    launch: async (command) => {
      launchCalls.push(command);
    },
    upload: async (data, remotePath) => {
      uploads.push({ path: remotePath, bytes: data.length });
    },
  };
  return { io, execCalls, launchCalls, uploads };
}

const noSleep = () => Promise.resolve();

test("shellQuote wraps and escapes embedded single quotes", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("compressAgent gzips and round-trips", () => {
  const original = Buffer.from("runtime-agent binary bytes".repeat(100));
  const gz = compressAgent(original);
  assert.ok(gz.length < original.length, "expected compression to shrink");
  assert.deepEqual(gunzipSync(gz), original);
});

test("agentPrepScript gunzips then chmods (synchronous, so failures surface)", () => {
  const script = agentPrepScript();
  assert.ok(script.includes(`gunzip -f ${AGENT_GZ_PATH}`));
  assert.ok(script.includes(`chmod 755 ${AGENT_BINARY_PATH}`));
});

test("agentLaunchScript launches detached with the secret and port", () => {
  const script = agentLaunchScript("s3cr3t");
  assert.ok(script.includes("setsid env RUNTIME_AGENT_SECRET='s3cr3t'"));
  assert.ok(script.includes("PORT=8080"));
  // Detached and input-closed so it outlives the launch call.
  assert.ok(script.trim().endsWith("< /dev/null &"));
});

test("agentLaunchScript injects project secrets as quoted env", () => {
  const script = agentLaunchScript("k", { CLAUDE_CODE_OAUTH_TOKEN: "tok en", GITHUB_TOKEN: "g" });
  assert.ok(script.includes("CLAUDE_CODE_OAUTH_TOKEN='tok en'"));
  assert.ok(script.includes("GITHUB_TOKEN='g'"));
});

test("ProvisionTimer records ordered stages, total, and fires onStage", async () => {
  let clock = 1000;
  const seen: string[] = [];
  const timer = new ProvisionTimer({
    now: () => clock,
    onStage: (t) => seen.push(`${t.stage}:${t.ms}`),
  });
  await timer.stage("sandbox_create", async () => {
    clock += 40;
  });
  await timer.stage("agent_upload", async () => {
    clock += 15;
  });
  const timings = timer.timings();
  assert.deepEqual(seen, ["sandbox_create:40", "agent_upload:15"]);
  assert.deepEqual(
    timings.stages.map((s) => [s.stage, s.ms]),
    [["sandbox_create", 40], ["agent_upload", 15]],
  );
  assert.equal(timings.totalMs, 55);
});

test("ProvisionTimer records a stage even when it throws", async () => {
  let clock = 0;
  const timer = new ProvisionTimer({ now: () => (clock += 10) });
  await assert.rejects(
    timer.stage("agent_boot", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(timer.timings().stages[0].stage, "agent_boot");
});

test("uploadAgent uploads the compressed binary to the .gz path", async () => {
  const box = fakeBox([]);
  await uploadAgent(box.io, Buffer.from("x".repeat(500)));
  assert.equal(box.uploads.length, 1);
  assert.equal(box.uploads[0].path, AGENT_GZ_PATH);
  assert.ok(box.uploads[0].bytes > 0);
});

test("bootAgent throws on prep failure and never launches the daemon", async () => {
  const box = fakeBox([
    { match: (c) => c.includes("gunzip"), result: { stdout: "gzip: not found", exitCode: 1 } },
  ]);
  await assert.rejects(bootAgent(box.io, "s"), /agent prep failed \(exit 1\): gzip: not found/);
  assert.equal(box.launchCalls.length, 0);
});

test("bootAgent launches the daemon via the async path after a clean prep", async () => {
  const box = fakeBox([]);
  await bootAgent(box.io, "sec", { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  assert.equal(box.launchCalls.length, 1);
  // The launch is wrapped in `bash -lc '<quoted>'`, so assert on markers that
  // survive shell-quoting (the `=` prefixes and the values themselves).
  assert.ok(box.launchCalls[0].startsWith("bash -lc "));
  assert.ok(box.launchCalls[0].includes("setsid env RUNTIME_AGENT_SECRET="));
  assert.ok(box.launchCalls[0].includes("CLAUDE_CODE_OAUTH_TOKEN="));
  assert.ok(box.launchCalls[0].includes("tok"));
});

test("waitForAgentHealth resolves once the probe returns 200", async () => {
  let probes = 0;
  const box = fakeBox([
    {
      match: (c) => c.includes("http_code") || c.includes("/health"),
      result: { stdout: "", exitCode: 0 },
    },
  ]);
  // Override exec to fail twice then succeed, and serve the log tail.
  box.io.exec = async (command) => {
    if (command.includes("/health")) {
      probes += 1;
      return { stdout: probes >= 3 ? "200" : "000", exitCode: 0 };
    }
    if (command.includes("cat")) return { stdout: "listening on :8080", exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  };
  const result = await waitForAgentHealth(box.io, { attempts: 5, intervalMs: 1, sleep: noSleep });
  assert.equal(result.logTail, "listening on :8080");
  assert.equal(probes, 3);
});

test("waitForAgentHealth throws with the log tail when the agent never binds", async () => {
  const box = fakeBox([
    { match: (c) => c.includes("curl"), result: { stdout: "000", exitCode: 0 } },
    { match: (c) => c.includes("cat"), result: { stdout: "panic: bad secret", exitCode: 0 } },
  ]);
  await assert.rejects(
    waitForAgentHealth(box.io, { attempts: 2, intervalMs: 1, sleep: noSleep }),
    /did not bind :8080[\s\S]*panic: bad secret/,
  );
});

test("deployAgent runs upload → prep → launch → health in order", async () => {
  const order: string[] = [];
  const io: BoxIO = {
    exec: async (command) => {
      if (command.includes("gunzip")) order.push("prep");
      if (command.includes("/health")) {
        order.push("health");
        return { stdout: "200", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    },
    launch: async () => {
      order.push("launch");
    },
    upload: async () => {
      order.push("upload");
    },
  };
  await deployAgent(io, Buffer.from("bin"), "secret", { attempts: 1, sleep: noSleep });
  assert.deepEqual(order.slice(0, 4), ["upload", "prep", "launch", "health"]);
});

// --- Claude engine deploy --------------------------------------------------

test("claudeInstallScript updates apt before installing tmux + tooling", () => {
  const s = claudeInstallScript();
  // apt-get update MUST precede install, else tmux is "no installation candidate".
  // Assert presence first — otherwise a missing update reads as indexOf -1 < N.
  assert.ok(s.includes("apt-get update"), "runs apt-get update");
  assert.ok(s.indexOf("apt-get update") < s.indexOf("install -y"), "update before install");
  for (const pkg of ["tmux", "git-lfs", "ripgrep", "jq"]) {
    assert.ok(s.includes(pkg), `installs ${pkg}`);
  }
});

test("claudeInstallScript installs the pinned Codex, after the tools", () => {
  const s = claudeInstallScript();
  assert.ok(s.includes(`sudo env "PATH=$PATH" npm install -g @openai/codex@`), "installs Codex through sudo with the shell's PATH");
  assert.ok(s.indexOf("apt-get install") < s.indexOf("npm install"), "tools first");
});

// `gh` is what the agent's orientation tells it to open pull requests with, and
// the box's GH_TOKEN signs it in. No base image has it and Debian doesn't ship
// it, so the deploy installs the release itself.
test("claudeInstallScript installs the pinned gh, for the architecture the box reports", () => {
  const s = claudeInstallScript();
  assert.ok(s.includes(`/v${GH_VERSION}/gh_${GH_VERSION}_linux_$arch.tar.gz`), "installs the pinned gh");
  // uname, not dpkg: the mapping must cover both architectures a box runs on.
  assert.match(s, /x86_64\) arch=amd64;; aarch64\|arm64\) arch=arm64;;/);
  // Whole release down before anything is unpacked, so a cut connection can't
  // leave a half-written gh on the PATH.
  assert.ok(s.indexOf("-o \"$tmp/gh.tar.gz\"") < s.indexOf("tar -xzf"), "downloads before unpacking");
  assert.ok(s.includes("sudo install -m 0755"), "installs it as root, world-executable");
  assert.ok(s.includes("/usr/local/bin/gh"), "puts gh on every user's PATH");
});

test("claudeInstallScript fails when the tools can't be installed, whatever Codex does", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  // No tmux or jq, a sudo that fails apt but runs npm, and Codex installing fine.
  const bin = mkdtempSync(join(tmpdir(), "install-fail-"));
  writeFileSync(join(bin, "sudo"), `#!/bin/sh\ncase "$*" in *apt-get*) exit 1;; *) exit 0;; esac\n`);
  chmodSync(join(bin, "sudo"), 0o755);
  // Only the stand-ins on PATH: a machine's own tmux or jq mustn't count.
  assert.throws(() =>
    execFileSync("/bin/sh", ["-c", claudeInstallScript()], { env: { ...process.env, PATH: bin }, stdio: "ignore" }),
  );
});

test("claudeInstallScript skips the install when the box already has the tools", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  // A PATH with tmux, jq, a newer claude, codex and gh present, and a sudo
  // that records being called: every install is guarded, so none of them runs.
  const bin = mkdtempSync(join(tmpdir(), "install-"));
  const called = join(bin, "sudo-called");
  for (const [name, body] of [["tmux", "exit 0"], ["jq", "exit 0"], ["claude", "echo '2.1.999 (Claude Code)'"], ["codex", "exit 0"], ["gh", "exit 0"], ["sudo", `touch ${called}; exit 1`]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  execFileSync("/bin/sh", ["-c", claudeInstallScript()], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(called), false, "sudo was not called");
});

/** A box whose `claude` reports the version in a file, whose npm "installs"
 *  Claude by writing the version it was asked for there (or, `npmTakes`
 *  false, leaves the old one first on the PATH), and whose sudo runs what it's
 *  given on its own PATH, as the real one's secure_path does: only `env` is on
 *  it, so no npm of the machine's own can stand in. npm's global prefix is
 *  root's unless `ownPrefix`; `rootOwned` is a folder in a prefix the user
 *  owns that a root install left as root's. npm fails, as the real one does,
 *  to install into a folder it can't write without sudo. With no version, `claude` fails as a missing one
 *  would. Every other tool is already there, Codex too unless `codex` is false. */
function claudeBox(
  version: string | null,
  { npmTakes = true, codex = true, ownPrefix = false, rootOwned = "" } = {},
) {
  const bin = mkdtempSync(join(tmpdir(), "claude-box-"));
  const securePath = mkdtempSync(join(tmpdir(), "secure-path-"));
  symlinkSync("/usr/bin/env", join(securePath, "env"));
  const file = join(bin, "claude-version");
  const npmLog = join(bin, "npm-log");
  const sudoLog = join(bin, "sudo-log");
  const tries = join(bin, "npm-tries");
  const own = ownPrefix || rootOwned !== "";
  const prefix = own ? mkdtempSync(join(tmpdir(), "npm-prefix-")) : join(bin, "root-owned-prefix");
  if (own) for (const dir of ["lib/node_modules", "bin"]) mkdirSync(join(prefix, dir), { recursive: true });
  if (rootOwned) {
    mkdirSync(join(prefix, rootOwned), { recursive: true });
    chmodSync(join(prefix, rootOwned), 0o555);
  }
  if (version) writeFileSync(file, version);
  const tools: [string, string][] = [
    ["tmux", "exit 0"],
    ["jq", "exit 0"],
    ["gh", "exit 0"],
    ["claude", `[ -f ${file} ] || exit 127; echo "$(cat ${file}) (Claude Code)"`],
    ["sudo", `echo "$*" >> ${sudoLog}; SUDO_USER=box PATH=${securePath} exec "$@"`],
    [
      "npm",
      // Into the package's scope folder where there is one, else node_modules.
      `[ "$1" = root ] && { echo ${prefix}/lib/node_modules; exit 0; }; ` +
        `echo "\${SUDO_USER:+sudo }$*" >> ${tries}; ` +
        `pkg=\${3%@*}; dir=${prefix}/lib/node_modules; ` +
        `case "$pkg" in @*/*) [ -d "$dir/\${pkg%%/*}" ] && dir="$dir/\${pkg%%/*}";; esac; ` +
        `[ -n "$SUDO_USER" ] || [ -w "$dir" ] || { echo "EACCES: $dir" >&2; exit 243; }; ` +
        `echo "$*" >> ${npmLog}; ` +
        `case "$3" in @anthropic-ai/*) ${npmTakes ? `echo "\${3##*@}" > ${file}` : "true"};; esac`,
    ],
  ];
  if (codex) tools.push(["codex", "exit 0"]);
  for (const [name, body] of tools) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const run = () =>
    spawnSync("/bin/sh", ["-c", claudeInstallScript()], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
  const read = (log: string) => { try { return readFileSync(log, "utf8"); } catch { return ""; } };
  return {
    run,
    npm: () => read(npmLog),
    tries: () => read(tries),
    sudo: () => read(sudoLog),
    version: () => readFileSync(file, "utf8").trim(),
  };
}

// Daytona's base image ships Claude Code 2.1.19, which stops at once on
// --effort: the deploy brings it up to the pinned version.
test("claudeInstallScript brings an old Claude Code up to the pinned version", () => {
  const box = claudeBox("2.1.19");
  const result = box.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(box.npm().trim(), `install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`);
  assert.equal(box.version(), CLAUDE_CODE_VERSION);
  // Root's node_modules: no install without sudo, sure to fail, first.
  assert.equal(box.tries().trim(), `sudo install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`);
});

// sudo's secure_path leaves out where Daytona's image puts npm: the installs
// carry the PATH npm was found on through sudo, Codex's as well as Claude's.
test("claudeInstallScript installs Codex where there is none, through sudo's own PATH", () => {
  const box = claudeBox(CLAUDE_CODE_VERSION, { codex: false });
  const result = box.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(box.npm().trim(), `install -g ${CODEX_PACKAGE}`);
  assert.match(box.sudo(), new RegExp(`env PATH=.* npm install -g ${CODEX_PACKAGE}`));
});

// nvm's prefix is the user's: root's files there would break a later install
// without sudo.
test("claudeInstallScript installs into a global prefix the user owns without sudo", () => {
  const box = claudeBox("2.1.19", { codex: false, ownPrefix: true });
  const result = box.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(box.version(), CLAUDE_CODE_VERSION);
  assert.match(box.npm(), new RegExp(`install -g ${CODEX_PACKAGE}`));
  assert.equal(box.sudo(), "", "sudo ran");
});

// A root install into nvm's prefix before leaves what it wrote root's: the
// whole node_modules, or just Claude's scope folder.
test("claudeInstallScript goes through sudo where a root install left the user's prefix", { skip: process.getuid?.() === 0 }, () => {
  for (const rootOwned of ["lib/node_modules", "lib/node_modules/@anthropic-ai"]) {
    const box = claudeBox("2.1.19", { rootOwned });
    const result = box.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(box.version(), CLAUDE_CODE_VERSION, rootOwned);
    assert.match(box.sudo(), /npm install -g @anthropic-ai\/claude-code@/, rootOwned);
  }
});

test("claudeInstallScript installs Claude Code where there is none", () => {
  const box = claudeBox(null);
  const result = box.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(box.version(), CLAUDE_CODE_VERSION);
});

test("claudeInstallScript leaves a newer Claude Code alone, and the pinned one too", () => {
  for (const version of ["2.1.999", "2.2.0", CLAUDE_CODE_VERSION]) {
    const box = claudeBox(version);
    const result = box.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(box.npm(), "", `npm ran for ${version}`);
  }
});

test("claudeInstallScript fails when the old Claude Code still comes first after the install", () => {
  const box = claudeBox("2.1.19", { npmTakes: false });
  const result = box.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, new RegExp(`Could not bring Claude Code \\(2\\.1\\.19\\) up to ${CLAUDE_CODE_VERSION.replaceAll(".", "\\.")}`));
});

test("claudeAgentSupervisorLaunchScript roots and supervises the agent at the box home", () => {
  const s = claudeAgentSupervisorLaunchScript("/home/daytona", "s3cr3t", {
    CLAUDE_CODE_OAUTH_TOKEN: "tok en",
  });
  assert.ok(s.includes("RUNTIME_AGENT_SECRET='s3cr3t'"));
  assert.ok(s.includes("RUNTIME_AGENT_ROOT='/home/daytona'"));
  assert.ok(s.includes("PORT=8080"));
  // HOME=root so `claude` reads the seeded ~/.claude.json under the same root.
  assert.ok(s.includes("HOME='/home/daytona'"));
  assert.ok(s.includes("CLAUDE_CODE_OAUTH_TOKEN='tok en'"));
  assert.ok(s.includes("runtime-agent-supervisor.pid"));
  assert.ok(s.includes(": > '/home/daytona/runtime-agent.log'"), "truncates old logs once before launch");
  assert.ok(s.includes('sleep "$delay"'), "backs off between failed child launches");
  assert.ok(s.includes('if [ "$lived" -ge 300 ]; then delay=1; fi'), "resets backoff after a stable run");
  // Detached and input-closed so the supervisor outlives the launch call.
  assert.ok(s.trim().endsWith("< /dev/null &"));
});

test("claudeConfigSeedScript jq-merges the onboarding-skip flags into ~/.claude.json", () => {
  const s = claudeConfigSeedScript("/home/daytona");
  assert.ok(s.includes("/home/daytona/.claude.json"), "targets the box's claude config");
  // Seeds an empty object first so jq has valid input on a fresh box.
  assert.ok(s.includes("echo '{}'"), "creates the file when absent");
  // The gates claude blocks on until each is pre-accepted.
  for (const flag of [
    "hasCompletedOnboarding",
    "theme",
    "bypassPermissionsModeAccepted",
    "hasTrustDialogAccepted",
  ]) {
    assert.ok(s.includes(flag), `seeds ${flag}`);
  }
  // A merge (`. + {...}`), not an overwrite, so base-image config survives.
  assert.ok(s.includes(". +"), "merges rather than overwrites");
});

const hasJq = spawnSync("jq", ["--version"]).status === 0;

test("claudeConfigSeedScript trusts the workspaces folder and keeps the existing config", { skip: !hasJq && "needs jq" }, () => {
  const root = mkdtempSync(join(tmpdir(), "seed-"));
  try {
    const f = join(root, ".claude.json");
    writeFileSync(f, JSON.stringify({ cachedFlags: 1, projects: { "/elsewhere": { allowedTools: ["x"] } } }));
    const run = spawnSync("bash", ["-c", claudeConfigSeedScript(root)], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const seeded = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(seeded.hasCompletedOnboarding, true);
    assert.equal(seeded.cachedFlags, 1, "keeps the base image's config");
    assert.deepEqual(seeded.projects["/elsewhere"], { allowedTools: ["x"] }, "keeps other folders' entries");
    // Claude 2.1.293 asks per folder; an entry for a parent covers each worktree.
    assert.equal(seeded.projects[`${root}/workspaces`].hasTrustDialogAccepted, true);

    rmSync(f);
    assert.equal(spawnSync("bash", ["-c", claudeConfigSeedScript(root)]).status, 0);
    assert.equal(JSON.parse(readFileSync(f, "utf8")).projects[`${root}/workspaces`].hasTrustDialogAccepted, true, "seeds a fresh box too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployClaude runs install → upload → prep → seed → launch → health in order", async () => {
  const order: string[] = [];
  const io: BoxIO = {
    exec: async (command) => {
      if (command.includes("apt-get")) order.push("install");
      if (command.includes("pkill")) order.push("stop");
      if (command.includes("gunzip")) order.push("prep");
      if (command.includes(".claude.json")) order.push("seed");
      if (command.includes("/health")) {
        order.push("health");
        return { stdout: "200", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    },
    launch: async () => {
      order.push("launch");
    },
    upload: async () => {
      order.push("upload");
    },
  };
  await deployClaude(io, Buffer.from("bin"), "secret", {
    root: "/home/daytona",
    attempts: 1,
    sleep: noSleep,
  });
  // A running agent (a box resumed with its processes) is stopped before its
  // binary is replaced and a new one takes the port.
  assert.deepEqual(order, ["install", "stop", "upload", "prep", "seed", "launch", "health"]);
});

test("deployClaude doesn't upload an agent the box has already (a restored one)", async () => {
  const binary = Buffer.from("bin");
  const order: string[] = [];
  const io: BoxIO = {
    exec: async (command) => {
      if (command.includes("sha256sum")) {
        return { stdout: `${createHash("sha256").update(binary).digest("hex")}\n`, exitCode: 0 };
      }
      if (command.includes("gunzip")) order.push("prep");
      if (command.includes("/health")) return { stdout: "200", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    },
    launch: async () => {
      order.push("launch");
    },
    upload: async () => {
      order.push("upload");
    },
  };
  await deployClaude(io, binary, "secret", { root: "/home/runtime", attempts: 1, sleep: noSleep });
  assert.deepEqual(order, ["launch"]);
});

test("deployClaude throws (and never launches) when the config seed fails", async () => {
  const box = fakeBox([
    { match: (c) => c.includes(".claude.json"), result: { stdout: "jq: parse error", exitCode: 1 } },
  ]);
  await assert.rejects(
    deployClaude(box.io, Buffer.from("bin"), "s", { root: "/home/daytona", attempts: 1, sleep: noSleep }),
    /claude config seed failed \(exit 1\): jq: parse error/,
  );
  assert.equal(box.launchCalls.length, 0);
});

// --- jcode engine deploy ---------------------------------------------------

test("jcodePaths derives box paths from a non-/home/runtime root", () => {
  const p = jcodePaths("/home/daytona");
  assert.equal(p.apiSocket, "/home/daytona/jcode-api.sock");
  assert.equal(p.daemonSocket, "/home/daytona/.jcode-run/daemon.sock");
  assert.deepEqual(p.credDirs, ["/home/daytona/.jcode", "/home/daytona/.config/jcode"]);
  assert.equal(p.agentBinary, "/home/daytona/runtime-agent");
});

test("jcodeBridgeScript carries the verified socket fix", () => {
  const s = jcodeBridgeScript("/tmp/node_modules/@1jehuang/jcode-linux-x64/bin/jcode", "/home/daytona");
  // The fix: real USER + writable runtime dir + pinned internal --socket.
  assert.ok(s.includes("USER=runtime"), "USER must be set");
  assert.ok(s.includes("XDG_RUNTIME_DIR=/home/daytona/.jcode-run"), "XDG_RUNTIME_DIR must be set");
  assert.ok(s.includes("TMPDIR=/home/daytona/.jcode-run"));
  assert.ok(s.includes("--socket /home/daytona/.jcode-run/daemon.sock"), "internal daemon socket must be pinned");
  assert.ok(s.includes("api-bridge --api-socket /home/daytona/jcode-api.sock"));
  assert.ok(s.includes("-p claude"));
  assert.ok(s.includes("JCODE_CLAUDE_SDK_PERMISSION_MODE=bypassPermissions"), "must bypass approval");
  assert.ok(s.includes("setsid") && s.trimEnd().endsWith("&"), "must launch detached");
});

test("jcodeAgentLaunchScript runs the agent in jcode mode against the bridge", () => {
  const s = jcodeAgentLaunchScript("/home/daytona", "s3cr3t");
  assert.ok(s.includes("RUNTIME_ENGINE=jcode"));
  assert.ok(s.includes("JCODE_API_SOCKET=/home/daytona/jcode-api.sock"));
  assert.ok(s.includes("RUNTIME_AGENT_SECRET='s3cr3t'"));
  assert.ok(s.includes("RUNTIME_AGENT_ROOT=/home/daytona"));
  assert.ok(s.includes("/home/daytona/runtime-agent"));
});

test("installJcode returns the linux binary path from the install output", async () => {
  const { io } = fakeBox([
    { match: (c) => c.includes("npm i @1jehuang/jcode-sdk"), result: { stdout: "\n/tmp/node_modules/@1jehuang/jcode-linux-x64/bin/jcode\n", exitCode: 0 } },
  ]);
  assert.equal(await installJcode(io), "/tmp/node_modules/@1jehuang/jcode-linux-x64/bin/jcode");
});

test("injectJcodeCreds uploads auth.json to both cred dirs", async () => {
  const { io, uploads } = fakeBox([]);
  await injectJcodeCreds(io, "/home/daytona", Buffer.from("AUTH"), Buffer.from("REFRESH"));
  const authPaths = uploads.filter((u) => u.path.endsWith("/auth.json")).map((u) => u.path);
  assert.deepEqual(authPaths, ["/home/daytona/.jcode/auth.json", "/home/daytona/.config/jcode/auth.json"]);
  assert.ok(uploads.some((u) => u.path.endsWith("/.jcode/auth-refresh-state.json")));
});

test("deployJcode runs creds → install → bridge → agent → health in order", async () => {
  const order: string[] = [];
  const io: BoxIO = {
    exec: async (command) => {
      if (command.includes("mkdir -p") && command.includes("jcode")) order.push("creds");
      if (command.includes("npm i @1jehuang/jcode-sdk")) { order.push("install"); return { stdout: "/tmp/node_modules/@1jehuang/jcode-linux-x64/bin/jcode", exitCode: 0 }; }
      if (command.includes("test -S")) { order.push("socket"); return { stdout: "yes", exitCode: 0 }; }
      if (command.includes("gunzip")) { order.push("prep"); return { stdout: "", exitCode: 0 }; }
      if (command.includes("/health")) { order.push("health"); return { stdout: "200", exitCode: 0 }; }
      return { stdout: "", exitCode: 0 };
    },
    launch: async (command) => { order.push(command.includes("api-bridge") ? "bridge" : "agent"); },
    upload: async () => {},
  };
  const res = await deployJcode(io, Buffer.from("bin"), "secret", {
    root: "/home/daytona", authJson: Buffer.from("A"), attempts: 1, sleep: noSleep,
  });
  // creds first, install, bridge launched + socket confirmed, agent prep+launch, health.
  assert.deepEqual(
    order.filter((o) => ["creds", "install", "bridge", "socket", "prep", "agent", "health"].includes(o)),
    ["creds", "creds", "install", "bridge", "socket", "prep", "agent", "health"],
  );
  assert.equal(res.logTail, "");
});
