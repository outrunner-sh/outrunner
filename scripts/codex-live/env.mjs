import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export const root =
  process.env.CODEX_LIVE_ROOT ??
  resolve(import.meta.dirname, "../../.context/codex-live");
export const secrets = JSON.parse(readFileSync(root + "/secrets.json", "utf8"));
// Deliberately do not inherit deployment/provider environment variables.
export const systemEnv = {
  PATH:
    root +
    "/codex/node_modules/.bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: root + "/home",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
};
export const env = {
  ...systemEnv,
  CODEX_LIVE_ROOT: root,
  NEXT_PUBLIC_SUPABASE_URL: secrets.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: secrets.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: secrets.SERVICE_ROLE_KEY,
  CREDENTIALS_ENCRYPTION_KEY: secrets.CREDENTIALS_ENCRYPTION_KEY,
  RUNTIME_AGENT_SECRET: secrets.RUNTIME_AGENT_SECRET,
  RUNTIME_AGENT_MEMBER_SECRET: secrets.RUNTIME_AGENT_MEMBER_SECRET,
  RUNTIME_BASE_URL: "http://127.0.0.1:3408",
  RUNTIME_BILLING: "off",
  RUNTIME_AGENT_ROOT: root + "/runtime",
  RUNTIME_TMUX_SOCKET: "outrunner-codex-test-live328",
  HOST: "127.0.0.1",
};
if (!env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Missing isolated stack credentials");

if (secrets.API_URL !== "http://127.0.0.1:55421")
  throw new Error("Refusing a non-isolated Supabase endpoint");
