#!/usr/bin/env node
// `npx outrunner`: run the Go CLI built for this computer. npm installs only
// the platform package whose `os` and `cpu` match (the optionalDependencies),
// so this finds it and hands over the terminal. scripts/build-cli.sh builds
// the packages.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Each platform's package. Windows's is named for the OS: npm's spam check refused
// the name outrunner-win32-x64. Keep in step with scripts/build-cli.sh.
const PACKAGES = {
  "darwin-arm64": "outrunner-darwin-arm64",
  "darwin-x64": "outrunner-darwin-x64",
  "linux-arm64": "outrunner-linux-arm64",
  "linux-x64": "outrunner-linux-x64",
  "win32-x64": "outrunner-windows-x64",
};
const pkg = PACKAGES[`${process.platform}-${process.arch}`] ?? `outrunner-${process.platform}-${process.arch}`;
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

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// A signal sent to this launcher alone (a closed terminal, a supervisor's
// SIGTERM) goes on to the CLI, which would otherwise outlive it, still
// waiting on its sign-in port. Ctrl-C reaches both already, through the
// terminal's process group: this only keeps the launcher waiting for the
// CLI to finish with it.
const forward = {
  SIGINT: () => {},
  SIGTERM: () => child.kill("SIGTERM"),
  SIGHUP: () => child.kill("SIGHUP"),
};
for (const [signal, handler] of Object.entries(forward)) process.on(signal, handler);

child.on("error", (error) => {
  console.error(`outrunner: couldn't run ${binary}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    // Die the way it did, for the shell to see.
    for (const [name, handler] of Object.entries(forward)) process.off(name, handler);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
