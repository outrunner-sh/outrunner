import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyCodexCli } from "../scripts/verify-codex-cli.mjs";

const version = "0.1.4";
const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"];
type Runner = NonNullable<Parameters<typeof verifyCodexCli>[2]>;
const registry = async (url: string | URL | Request) => {
  const name = String(url).split("/").at(-2);
  return Response.json({ version, dist: { integrity: "sha512-public-fixture" },
    ...(name === "outrunner" ? { optionalDependencies: Object.fromEntries(platforms.map(p => ["outrunner-" + p, version])) } : {}) });
};

test("release gate rejects dist tags, incomplete platform publication and missing codex-auth", async () => {
  await assert.rejects(verifyCodexCli("latest"), /exact published version/);
  await assert.rejects(verifyCodexCli(version, async () => new Response(null, { status: 404 })), /not available on public npm/);
  const oldBinary = ((_binary: string, args: string[]) =>
    args.at(-1) === "--version" ? { status: 0, stdout: "outrunner " + version } : { status: 2, stdout: "Commands:\n login\n claude\n" }) as unknown as Runner;
  await assert.rejects(verifyCodexCli(version, registry, oldBinary), /does not advertise codex-auth/);
});

test("release gate executes only version and help in a fresh home, never device authorization", async () => {
  const calls: string[][] = [];
  const binary = ((_binary: string, args: string[], options: { env: Record<string, string>; cwd: string }) => {
    calls.push(args);
    assert.equal(options.cwd, options.env.HOME);
    assert.equal(options.env.CODEX_HOME, undefined);
    return { status: args.at(-1) === "--help" ? 2 : 0,
      stdout: args.at(-1) === "--help" ? "Commands:\n  codex-auth [--org UUID]\n" : "outrunner " + version };
  }) as unknown as Runner;
  assert.equal(await verifyCodexCli(version, registry, binary), version);
  assert.deepEqual(calls.map(a => a.at(-1)), ["--version", "--help"]);
});
