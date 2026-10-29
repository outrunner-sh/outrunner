import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { acceptDoppler, acceptInfisical } from "@/lib/secret-sync/connect";
import { INFISICAL_CLI, infisicalInstallStep } from "@/lib/secret-sync/infisical-cli";
import { SyncError } from "@/lib/secret-sync/providers";
import { SecretSyncRuleError } from "@/lib/secret-sync/rules";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(respond: (url: URL, init: RequestInit) => Response): URL[] {
  const seen: URL[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    seen.push(new URL(url));
    return Promise.resolve(respond(new URL(url), init));
  }) as typeof fetch;
  return seen;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("a Doppler token is checked with Doppler before it's kept", async () => {
  answer(() => json({ DOPPLER_PROJECT: "api", DOPPLER_CONFIG: "dev" }));
  const connection = await acceptDoppler({ token: " dp.st.dev.abcdefghijkl " }, null);
  assert.deepEqual(connection, {
    provider: "doppler",
    credentials: { token: "dp.st.dev.abcdefghijkl" },
    settings: { tokenKind: "service", project: "api", config: "dev" },
    label: "api / dev",
  });
});

test("a Doppler connection refuses what isn't a token, and passes on Doppler's refusal", async () => {
  const seen = answer(() => json({}, 401));
  await assert.rejects(acceptDoppler({}, null), SecretSyncRuleError);
  await assert.rejects(acceptDoppler({ token: "sk-ant-abcdefghijkl" }, null), /isn't a Doppler token/);
  await assert.rejects(acceptDoppler({ token: "dp.pt.abcdefghijkl", project: "bad slug" }, null), SecretSyncRuleError);
  assert.equal(seen.length, 0, "nothing invalid is sent to Doppler");
  await assert.rejects(acceptDoppler({ token: "dp.st.dev.abcdefghijkl" }, null), (e: SyncError) => e instanceof SyncError && e.refused);
});

test("reconnecting Doppler without a token keeps the stored one, for a new project or config", async () => {
  const auth: string[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    auth.push((init.headers as Record<string, string>).authorization);
    return Promise.resolve(new URL(url).pathname === "/v3/me" ? json({ workplace: { name: "Acme" } }) : json({}));
  }) as typeof fetch;
  const connection = await acceptDoppler({ project: "web", config: "prd" }, { token: "dp.pt.storedtoken123" });
  assert.equal(connection.label, "Acme: web / prd");
  assert.deepEqual(auth, ["Bearer dp.pt.storedtoken123", "Bearer dp.pt.storedtoken123"]);
});

const loginThen = (secrets: Response) =>
  answer((url) => (url.pathname.endsWith("/universal-auth/login") ? json({ accessToken: "at" }) : secrets));

test("an Infisical machine identity is checked with its site before it's kept", async () => {
  const seen = loginThen(json({ secrets: [] }));
  const connection = await acceptInfisical(
    { clientId: "cid", clientSecret: "csecret", siteUrl: "https://eu.infisical.com", projectId: "p1", environment: "dev" },
    null,
  );
  assert.equal(connection.provider, "infisical");
  assert.deepEqual(connection.settings, { siteUrl: "https://eu.infisical.com", projectId: "p1", environment: "dev" });
  assert.equal(seen[0].origin, "https://eu.infisical.com");
});

test("a stored Infisical secret is reused only for the site it was given for", async () => {
  const stored = { credentials: { clientId: "cid", clientSecret: "csecret" }, siteUrl: "https://app.infisical.com" };
  loginThen(json({ secrets: [] }));
  const same = await acceptInfisical({ projectId: "p2", environment: "stg" }, stored);
  assert.deepEqual(same.credentials, stored.credentials);

  const seen = loginThen(json({ secrets: [] }));
  await assert.rejects(acceptInfisical({ siteUrl: "https://attacker.example.com" }, stored), /again for a new site URL/);
  assert.equal(seen.length, 0, "the stored secret isn't sent to a new site");
});

test("an Infisical connection refuses half a credential and a private site", async () => {
  await assert.rejects(acceptInfisical({ clientId: "cid" }, null), /together/);
  await assert.rejects(acceptInfisical({ clientId: "cid", clientSecret: "s", siteUrl: "https://127.0.0.1" }, null), /site URL/);
  await assert.rejects(acceptInfisical({ clientId: "cid", clientSecret: "s", siteUrl: "http://infisical.example.com" }, null), /site URL/);
});

// ---------------------------------------------------------------------------
// The CLI's install, run for real against a fake release

/** A box: a PATH with `curl` serving `tarball`, and the real sh, tar,
 *  sha256sum, install and friends. */
function box(tarball: Buffer) {
  const root = mkdtempSync(join(tmpdir(), "infisical-cli-"));
  const bin = join(root, "bin");
  const dest = join(root, "dest");
  mkdirSync(bin);
  mkdirSync(dest);
  writeFileSync(join(root, "release.tar.gz"), tarball);
  const curl = join(bin, "curl");
  // curl -fsSL URL -o FILE: the URL is recorded, the file is the release.
  writeFileSync(curl, `#!/bin/sh\necho "$2" >> "${root}/asked"\ncp "${root}/release.tar.gz" "$4"\n`);
  chmodSync(curl, 0o755);
  for (const tool of ["sh", "uname", "mktemp", "sha256sum", "tar", "gzip", "install", "rm", "cp", "cat", "echo"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found.startsWith("/")) spawnSync("ln", ["-s", found, join(bin, tool)]);
  }
  return { root, bin, dest };
}

function release(): { tarball: Buffer; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "infisical-release-"));
  writeFileSync(join(dir, "infisical"), "#!/bin/sh\necho infisical 0.0.0-test\n");
  chmodSync(join(dir, "infisical"), 0o755);
  writeFileSync(join(dir, "README.md"), "not installed\n");
  spawnSync("tar", ["-czf", join(dir, "release.tar.gz"), "-C", dir, "infisical", "README.md"]);
  const tarball = readFileSync(join(dir, "release.tar.gz"));
  return { tarball, sha256: createHash("sha256").update(tarball).digest("hex") };
}

const canRun = process.platform === "linux" && spawnSync("sh", ["-c", "command -v sha256sum && command -v tar"]).status === 0;

test("the CLI is installed from its pinned release when its checksum matches", { skip: !canRun }, () => {
  const { tarball, sha256 } = release();
  const { root, bin, dest } = box(tarball);
  const step = infisicalInstallStep({ version: "9.9.9", sha256: { amd64: sha256, arm64: sha256 } }, dest);
  const run = spawnSync("sh", ["-c", step], { env: { ...process.env, PATH: bin }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.ok(existsSync(join(dest, "infisical")));
  assert.ok(!existsSync(join(dest, "README.md")), "only the binary");
  assert.match(readFileSync(join(root, "asked"), "utf8"), /^https:\/\/github\.com\/Infisical\/cli\/releases\/download\/v9\.9\.9\/cli_9\.9\.9_linux_(amd64|arm64)\.tar\.gz\n$/);
});

test("a release whose checksum doesn't match installs nothing, says so, and lets the start hook go on", { skip: !canRun }, () => {
  const { tarball } = release();
  const { bin, dest } = box(tarball);
  const step = infisicalInstallStep({ version: "9.9.9", sha256: { amd64: "0".repeat(64), arm64: "0".repeat(64) } }, dest);
  const run = spawnSync("sh", ["-c", `${step}\necho next-step`], { env: { ...process.env, PATH: bin }, encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stderr, /couldn't install the Infisical CLI/);
  assert.equal(run.stdout.trim(), "next-step");
  assert.ok(!existsSync(join(dest, "infisical")));
});

test("a box that has the CLI downloads nothing", { skip: !canRun }, () => {
  const { tarball } = release();
  const { root, bin, dest } = box(tarball);
  writeFileSync(join(bin, "infisical"), "#!/bin/sh\n");
  chmodSync(join(bin, "infisical"), 0o755);
  const run = spawnSync("sh", ["-c", infisicalInstallStep(INFISICAL_CLI, dest)], { env: { ...process.env, PATH: bin }, encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.ok(!existsSync(join(root, "asked")));
});
