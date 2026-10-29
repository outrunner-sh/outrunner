/** Prepare a NEW disposable stack. Never loads .env or a hosted DB URL. */
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
const repo = resolve(import.meta.dirname, "../..");
const root = resolve(repo, ".context/codex-live");
if (existsSync(root))
  throw new Error(
    "Isolated directory already exists. Reuse it; do not overwrite a pending/connected test.",
  );
const run = (bin, args, cwd = repo) =>
  execFileSync(bin, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
// Fail before creating anything when Docker is unavailable. Follow Replicas'
// Docker skill to start the daemon; never target the reserved engine port.
run("docker", ["info", "--format", "{{.ServerVersion}}"]);
if (
  run("docker", ["ps", "-a", "--format", "{{.Names}}"]).includes(
    "_outrunner-codex-live-328",
  )
)
  throw new Error(
    "Existing isolated Supabase containers found; recover their original test directory first.",
  );
mkdirSync(root, { recursive: true, mode: 0o700 });
chmodSync(root, 0o700);
for (const dir of ["app", "stack", "home"])
  mkdirSync(root + "/" + dir, { mode: 0o700 });
const commit = run("git", ["rev-parse", "HEAD"]).trim();
const archive = execFileSync("git", ["archive", commit], {
  cwd: repo,
  maxBuffer: 64 * 1024 * 1024,
});
execFileSync("tar", ["-x", "-C", root + "/app"], { input: archive });
symlinkSync(repo + "/node_modules", root + "/app/node_modules");
const supabase = repo + "/node_modules/.bin/supabase";
run(supabase, ["init"], root + "/stack");
let config = readFileSync(root + "/stack/supabase/config.toml", "utf8");
config = config
  .replace(/^project_id = .*$/m, 'project_id = "outrunner-codex-live-328"')
  .replaceAll("port = 54321", "port = 55421")
  .replaceAll("port = 54322", "port = 55422")
  .replaceAll("port = 54320", "port = 55420")
  .replaceAll("port = 54323", "port = 55423")
  .replaceAll("port = 54324", "port = 55424")
  .replaceAll("port = 54329", "port = 55429")
  .replace('openai_api_key = "env(OPENAI_API_KEY)"', 'openai_api_key = ""')
  .replace('sql_paths = ["./seed.sql"]', "sql_paths = []")
  .replaceAll("enable_signup = true", "enable_signup = false");
writeFileSync(root + "/stack/supabase/config.toml", config);
run("cp", [
  "-r",
  root + "/app/supabase/migrations",
  root + "/stack/supabase/migrations",
]);
writeFileSync(
  root + "/stack/supabase/migrations/20260101000000_isolated_legacy_grants.sql",
  `
-- Test only: these app migrations target the preexisting Supabase default
-- grants. Apply those defaults BEFORE migrations' explicit RLS/revokes.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
`,
);
console.log("Starting fresh isolated Supabase and applying branch migrations…");
try {
  const output = run(
    supabase,
    [
      "start",
      "--exclude",
      "studio,vector,logflare,realtime,edge-runtime,supavisor,imgproxy",
      "-o",
      "json",
    ],
    root + "/stack",
  );
  const keys = JSON.parse(
    output
      .split("\n")
      .reverse()
      .find((s) => s.startsWith("{")),
  );
  keys.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  keys.RUNTIME_AGENT_SECRET = randomBytes(32).toString("hex");
  keys.RUNTIME_AGENT_MEMBER_SECRET = randomBytes(32).toString("hex");
  writeFileSync(root + "/secrets.json", JSON.stringify(keys), { mode: 0o600 });
} catch {
  throw new Error(
    "Isolated Supabase startup/migration failed. Inspect only this new local project; no hosted DB was used.",
  );
}
// From this point children receive only this stack's freshly generated config.
process.env.CODEX_LIVE_ROOT = root;
const { env, systemEnv } = await import("./env.mjs");
const task = async (bin, args, cwd, childEnv = env) =>
  new Promise((ok, fail) => {
    const child = spawn(bin, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", fail);
    child.on("exit", (code) => {
      if (code === 0) ok();
      else {
        writeFileSync(root + "/prepare-error.log", output, { mode: 0o600 });
        fail(
          new Error("Isolated build failed; see private prepare-error.log."),
        );
      }
    });
  });
console.log(
  "Building branch CLI/runtime, installing pinned native Codex and building app…",
);
await task(
  "go",
  ["build", "-o", root + "/runtime-agent", "./cmd/runtime-agent"],
  root + "/app/runtime-agent",
  { ...systemEnv, CGO_ENABLED: "0" },
);
await task(
  "go",
  ["build", "-o", root + "/outrunner", "./cmd/outrunner"],
  root + "/app/runtime-agent",
);
await task(
  "npm",
  [
    "install",
    "--prefix",
    root + "/codex",
    "--ignore-scripts",
    "--no-fund",
    "--no-audit",
    "@openai/codex@0.146.0",
  ],
  root,
);
await task("node", [root + "/app/scripts/codex-live/seed.mjs", commit], repo);
await task(
  "docker",
  [
    "build",
    "--build-arg",
    "RUNTIME_UID=" + process.getuid(),
    "--build-arg",
    "RUNTIME_GID=" + process.getgid(),
    "-t",
    "outrunner-codex-live-runtime:328",
    "-f",
    root + "/app/scripts/codex-live/Dockerfile.runtime",
    root + "/app/scripts/codex-live",
  ],
  repo,
  systemEnv,
);
await task(
  "node",
  [root + "/app/scripts/codex-live/launch.mjs", "build"],
  repo,
);
console.log(
  "Prepared " +
    commit +
    ". Follow scripts/codex-live/README.md to start the five named services and create an authenticated preview.",
);
