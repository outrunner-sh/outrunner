import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { root, env } from "./env.mjs";
const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const check = ({ data, error }) => {
  if (error) throw error;
  return data;
};
if (existsSync(root + "/state.json"))
  throw new Error("Already seeded; reuse the isolated identities");
const users = [];
for (const role of ["owner", "member", "outsider"]) {
  const u = check(
    await db.auth.admin.createUser({
      email: role + "@codex-live-328.invalid",
      email_confirm: true,
      user_metadata: { full_name: "Isolated Codex " + role },
    }),
  ).user;
  users.push({ id: u.id, email: u.email });
}
const org = check(
  await db
    .from("organizations")
    .insert({
      name: "Codex isolated validation · #328",
      created_by: users[0].id,
    })
    .select("id")
    .single(),
).id;
check(
  await db.from("organization_members").insert([
    { org_id: org, user_id: users[0].id, role: "admin" },
    { org_id: org, user_id: users[1].id, role: "member" },
  ]),
);
const otherOrg = check(
  await db
    .from("organizations")
    .insert({ name: "Other isolated organization", created_by: users[2].id })
    .select("id")
    .single(),
).id;
check(
  await db.from("organization_members").insert([
    { org_id: otherOrg, user_id: users[0].id, role: "admin" },
    { org_id: otherOrg, user_id: users[2].id, role: "admin" },
  ]),
);
const token = "or_cli_" + randomBytes(32).toString("base64url");
check(
  await db.from("cli_tokens").insert({
    user_id: users[0].id,
    token_hash: createHash("sha256").update(token).digest("hex"),
    device_name: "Isolated #328 branch CLI",
  }),
);
writeFileSync(
  root + "/cli.json",
  JSON.stringify({
    url: env.RUNTIME_BASE_URL,
    token,
    login: "Isolated Codex owner",
  }),
  { mode: 0o600 },
);
writeFileSync(
  root + "/state.json",
  JSON.stringify({
    org,
    otherOrg,
    owner: users[0],
    member: users[1],
    outsider: users[2],
    commit: process.argv[2],
  }),
  { mode: 0o600 },
);
console.log(
  "Created three isolated Auth users, org/admin/member and a revocable test-only CLI sign-in.",
);

const fixture = root + "/test-repo";
mkdirSync(fixture, { recursive: true, mode: 0o700 });
execFileSync("git", ["init", "-b", "main", fixture], { stdio: "pipe" });
writeFileSync(
  fixture + "/README.md",
  "Isolated Codex account verification. No production code or credentials.\n",
);
execFileSync("git", ["-C", fixture, "add", "README.md"]);
execFileSync(
  "git",
  [
    "-C",
    fixture,
    "-c",
    "user.name=Isolated Codex test",
    "-c",
    "user.email=codex-test@example.invalid",
    "commit",
    "-m",
    "Create isolated verification fixture\n\nCo-Authored-By: immad sahin <84772210+immadsahin@users.noreply.github.com>\nCo-Authored-By: replicas-connector[bot] <replicas-connector[bot]@users.noreply.github.com>",
  ],
  { stdio: "pipe" },
);
