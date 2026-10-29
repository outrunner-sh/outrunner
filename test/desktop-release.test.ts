import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/desktop-release.yml", "utf8");

// Exercise the actual workflow scripts without building/signing a Mac app or
// touching GitHub Releases. Step metadata stays in the same fixture as its script.
function step(name: string) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing step: ${name}`);
  const end = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, end < 0 ? undefined : end);
}

function script(name: string) {
  return step(name).split("        run: |\n")[1]
    .split("\n").filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10)).join("\n");
}

function run(name: string, cwd: string, env: Record<string, string>) {
  return execFileSync("bash", ["-e", "-o", "pipefail", "-c", script(name)], {
    cwd, env: { ...process.env, ...env }, encoding: "utf8",
  });
}

for (const [mode, event, refType, publish] of [
  ["none", "workflow_dispatch", "branch", "false"],
  ["draft", "push", "tag", "false"],
  ["publish", "push", "branch", "true"],
] as const) {
  test(`desktop ${mode}: route files to the correct storage and retain checksums`, () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-release-"));
    try {
      const output = join(dir, "output");
      const envFile = join(dir, "env");
      writeFileSync(output, "");
      writeFileSync(envFile, "");
      run("Resolve version", dir, {
        GITHUB_EVENT_NAME: event, GITHUB_REF_TYPE: refType,
        GITHUB_REF_NAME: "desktop-v1.2.3", INPUT_VERSION: "1.2.3",
        INPUT_PUBLISH: publish, GITHUB_OUTPUT: output, GITHUB_ENV: envFile,
        BUNDLE_DIR: "bundle", RUNNER_TEMP: dir,
      });
      assert.match(readFileSync(output, "utf8"), new RegExp(`^release=${mode}$`, "m"));

      const upload = step("Upload artifact");
      assert.match(upload, /if: steps\.version\.outputs\.release == 'none'/);
      assert.match(upload, /retention-days: 3\b/);
      assert.match(upload, /if-no-files-found: error/);
      assert.ok(workflow.indexOf("- name: Verify signature, notarization and bundle") < workflow.indexOf("- name: Collect release files"));

      const dmg = join(dir, "app.dmg");
      const update = join(dir, "app.tar.gz");
      writeFileSync(dmg, "signed and notarized DMG");
      writeFileSync(update, "signed update bundle");
      writeFileSync(`${update}.sig`, "updater signature");
      const out = join(dir, "release");
      run("Collect release files", dir, { VERSION: "1.2.3", DMG: dmg, UPDATE: update, OUT: out });
      const assets = ["Outrunner_1.2.3_universal.app.tar.gz", "Outrunner_1.2.3_universal.app.tar.gz.sig", "Outrunner_1.2.3_universal.dmg", "SHA256SUMS"];
      assert.deepEqual(readdirSync(out).sort(), assets);
      execFileSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: out });
      if (mode === "none") return;

      const releaseStep = mode === "draft" ? "Attach to a draft release" : "Publish the release";
      assert.match(step(releaseStep), new RegExp(`if: steps\\.version\\.outputs\\.release == '${mode}'`));
      const calls = join(dir, "gh-calls");
      // No existing release: record the actual arguments, including shell glob
      // expansion of all four assets, then make view report absence.
      writeFileSync(join(dir, "gh"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.GH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(process.argv[3] === 'view' ? 1 : 0);\n`, { mode: 0o755 });
      run(releaseStep, dir, {
        PATH: `${dir}:${process.env.PATH}`, GH_CALLS: calls, OUT: out,
        VERSION: "1.2.3", TAG: "desktop-v1.2.3", GITHUB_SHA: "test-head",
      });
      const commands = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      const create = commands.find((args) => args[0] === "release" && args[1] === "create");
      assert.ok(create);
      assert.deepEqual(create.filter((arg) => arg.startsWith(`${out}/`)).map((arg) => arg.slice(out.length + 1)).sort(), assets);
      assert.equal(create.includes("--draft"), mode === "draft");
      assert.equal(create.includes("--latest"), mode === "publish");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("desktop publish fetches Release assets and verifies checksums and update signatures", () => {
  const publish = readFileSync(".github/workflows/desktop-publish.yml", "utf8");
  assert.match(publish, /gh release download/);
  assert.doesNotMatch(publish, /actions\/download-artifact/);
  assert.match(publish, /sha256sum -c SHA256SUMS/);
  assert.match(publish, /minisign -V/);
});
