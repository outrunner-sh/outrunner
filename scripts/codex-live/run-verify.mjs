import { spawn } from "node:child_process";
import { env, root } from "./env.mjs";
const p = spawn(
  "node",
  [
    "--experimental-transform-types",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--import",
    root + "/app/scripts/codex-live/next-loader.mjs",
    "--import",
    "./scripts/test-loader.mjs",
    root + "/app/scripts/codex-live/verify.mjs",
    ...process.argv.slice(2),
  ],
  { cwd: root + "/app", env, stdio: "inherit" },
);
p.on("exit", (c) => process.exit(c ?? 1));
