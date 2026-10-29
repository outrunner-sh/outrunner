/** Public npm release gate. Never runs login or reads the operator's CLI home. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export async function verifyCodexCli(version, request = fetch, run = spawnSync) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ""))
    throw new Error("Pin NEXT_PUBLIC_CODEX_CLI_VERSION in image_vars to an exact published version containing codex-auth.");
  const packages = ["outrunner", "outrunner-linux-x64", "outrunner-linux-arm64", "outrunner-darwin-x64", "outrunner-darwin-arm64", "outrunner-windows-x64"];
  const metadata = await Promise.all(packages.map(async (name) => {
    const response = await request(`https://registry.npmjs.org/${name}/${version}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${name}@${version} is not available on public npm (HTTP ${response.status}). Publish the complete CLI release first.`);
    const value = await response.json();
    if (value.version !== version || !value.dist?.integrity) throw new Error(`Invalid public release metadata for ${name}@${version}.`);
    return value;
  }));
  for (const name of packages.slice(1))
    if (metadata[0].optionalDependencies?.[name] !== version)
      throw new Error(`outrunner@${version} does not pin ${name}@${version}.`);
  const home = mkdtempSync(join(tmpdir(), "outrunner-release-check-"));
  try {
    const options = { cwd: home, encoding: "utf8", timeout: 90000, env: {
      PATH: process.env.PATH, HOME: home, NPM_CONFIG_CACHE: join(home, "cache"),
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org", NPM_CONFIG_LOGLEVEL: "error", NO_UPDATE_NOTIFIER: "1",
    } };
    const invoke = (flag) => run("npm", ["exec", "--yes", "--package", `outrunner@${version}`, "--", "outrunner", flag], options);
    const binary = invoke("--version");
    if (binary.status !== 0 || binary.stdout?.trim() !== `outrunner ${version}`)
      throw new Error(`Public outrunner@${version} did not execute its expected version.`);
    const help = invoke("--help");
    // The Go CLI intentionally exits 2 for usage; this never begins auth.
    if (![0, 2].includes(help.status) || !/^\s*codex-auth\b/m.test((help.stdout ?? "") + (help.stderr ?? "")))
      throw new Error(`Public outrunner@${version} does not advertise codex-auth. Do not enable this version in settings.`);
  } finally { rmSync(home, { recursive: true, force: true }); }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log("Verified public Codex CLI release " + await verifyCodexCli(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
