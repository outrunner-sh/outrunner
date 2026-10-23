#!/usr/bin/env node
// `npx outrunner`: run the Go CLI built for this computer. npm installs only
// the platform package whose `os` and `cpu` match (the optionalDependencies),
// so this finds it and hands over the terminal. scripts/build-cli.sh builds
// the packages.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const pkg = `outrunner-${process.platform}-${process.arch}`;
const exe = process.platform === "win32" ? "outrunner.exe" : "outrunner";

let binary;
try {
  binary = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "bin", exe);
} catch {
  console.error(
    `outrunner: there is no build for ${process.platform} ${process.arch} (${pkg} isn't installed).\n` +
      "If you installed with --no-optional or --omit=optional, install again without it.",
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`outrunner: couldn't run ${binary}: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
