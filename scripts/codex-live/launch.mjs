import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { env, root } from "./env.mjs";
mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
const mode = process.argv[2];
let child;
if (mode === "app")
  child = spawn(
    "node",
    [
      "--experimental-strip-types",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "server.ts",
    ],
    {
      cwd: root + "/app",
      env: { ...env, PORT: "3408", NODE_ENV: "production" },
      stdio: "inherit",
    },
  );
else if (mode === "build")
  child = spawn(root + "/app/node_modules/.bin/next", ["build"], {
    cwd: root + "/app",
    env: { ...env, NODE_ENV: "production" },
    stdio: "inherit",
  });
else if (mode === "runtime")
  child = spawn(root + "/runtime-agent", [], {
    env: { ...env, PORT: "3409" },
    stdio: "inherit",
  });
else if (mode === "runtime-member") {
  mkdirSync(root + "/home-member", { recursive: true, mode: 0o700 });
  child = spawn(root + "/runtime-agent", [], {
    env: {
      ...env,
      PORT: "3411",
      HOME: root + "/home-member",
      RUNTIME_AGENT_ROOT: root + "/runtime-member",
      RUNTIME_AGENT_SECRET: env.RUNTIME_AGENT_MEMBER_SECRET,
      RUNTIME_TMUX_SOCKET: "outrunner-codex-test-live328-member",
    },
    stdio: "inherit",
  });
} else throw new Error("Unknown service");
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
