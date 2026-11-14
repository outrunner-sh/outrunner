import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

/**
 * `npx outrunner`'s launcher (cli-npm/bin/outrunner.mjs), installed beside a
 * stand-in for the platform's Go CLI: a script that says its pid, then waits
 * or exits as told.
 */
const skip = process.platform === "win32" ? "the stand-in CLI is a shell script" : false;
const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function install() {
  const dir = await mkdtemp(path.join(tmpdir(), "outrunner-launcher-"));
  dirs.push(dir);
  const modules = path.join(dir, "node_modules");
  const launcher = path.join(modules, "outrunner", "bin", "outrunner.mjs");
  await mkdir(path.dirname(launcher), { recursive: true });
  await copyFile(path.join(import.meta.dirname, "..", "cli-npm", "bin", "outrunner.mjs"), launcher);

  const pkg = `outrunner-${process.platform}-${process.arch}`;
  const cli = path.join(modules, pkg, "bin", "outrunner");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(path.join(modules, pkg, "package.json"), JSON.stringify({ name: pkg, version: "0.0.0" }));
  await writeFile(cli, '#!/bin/sh\necho $$ > "$PID_FILE"\n[ -n "$EXIT_WITH" ] && exit "$EXIT_WITH"\nexec sleep 30\n');
  await chmod(cli, 0o755);
  return { launcher, pidFile: path.join(dir, "cli.pid") };
}

async function cliPid(pidFile: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const text = await readFile(pidFile, "utf8").catch(() => "");
    if (text.trim()) return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the CLI never started");
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a SIGTERM to the launcher stops the CLI too, rather than leave it waiting", { skip }, async () => {
  const { launcher, pidFile } = await install();
  const child = spawn(process.execPath, [launcher, "login"], { env: { ...process.env, PID_FILE: pidFile }, stdio: "ignore" });
  const exited = once(child, "exit");
  const pid = await cliPid(pidFile);
  assert.ok(running(pid));

  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.deepEqual([code, signal], [null, "SIGTERM"], "the launcher dies the way the CLI did");
  assert.ok(!running(pid), "the CLI outlived the launcher");
});

test("the CLI's exit status is the launcher's", { skip }, async () => {
  const { launcher, pidFile } = await install();
  const child = spawn(process.execPath, [launcher], { env: { ...process.env, PID_FILE: pidFile, EXIT_WITH: "3" }, stdio: "ignore" });
  const [code] = await once(child, "exit");
  assert.equal(code, 3);
});
