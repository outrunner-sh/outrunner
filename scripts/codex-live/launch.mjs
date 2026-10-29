import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { env, root, systemEnv, secrets } from "./env.mjs";
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
else if (mode === "runtime" || mode === "runtime-member") {
  const member = mode === "runtime-member";
  const name = member ? "computer-b" : "computer-a";
  const runtimeEnv = {
    ...systemEnv,
    HOME: "/data/home",
    PATH: "/opt/codex/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    RUNTIME_AGENT_ROOT: "/data/runtime",
    RUNTIME_AGENT_SECRET: member
      ? secrets.RUNTIME_AGENT_MEMBER_SECRET
      : secrets.RUNTIME_AGENT_SECRET,
    RUNTIME_TMUX_SOCKET: "outrunner-codex-test-live328",
  };
  child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--name",
      "outrunner-codex-live-" + name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--mount",
      "type=bind,src=" + root + "/" + name + ",dst=/data",
      "--mount",
      "type=bind,src=" + root + "/codex,dst=/opt/codex,readonly",
      "--mount",
      "type=bind,src=" +
        root +
        "/runtime-agent,dst=/opt/runtime-agent,readonly",
      ...Object.keys(runtimeEnv).flatMap((key) => ["--env", key]),
      "outrunner-codex-live-runtime:328",
    ],
    { env: runtimeEnv, stdio: "inherit" },
  );
} else throw new Error("Unknown service");
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
