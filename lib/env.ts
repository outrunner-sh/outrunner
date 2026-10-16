/**
 * Central environment access.
 *
 * Configuration is intentionally flat: everything is read from process.env and
 * validated lazily at the call site rather than at import time (so `next build`
 * works without secrets).
 */

import type { ProviderName } from "@/lib/runtime/types";

// Per-user credentials (each user's GitHub token and Claude key) are NOT here:
// they live encrypted in the database, not in the deployment's environment. A
// shared GITHUB_PAT / ANTHROPIC_API_KEY / CODEX_API_KEY would land in a box
// where Claude runs with --permission-mode bypassPermissions, readable by
// whoever holds that box. See lib/db/credentials.ts.
type EnvKey =
  // Supabase
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  | "SUPABASE_SERVICE_ROLE_KEY"
  // Multi-user: AES-256-GCM key sealing per-user credentials at rest
  // (lib/crypto/secret-box.ts). 32 bytes, base64 or hex — `openssl rand -base64 32`.
  | "CREDENTIALS_ENCRYPTION_KEY"
  // Single-user guard
  | "RUNTIME_OWNER_GITHUB_LOGIN"
  // Modal
  | "MODAL_TOKEN_ID"
  | "MODAL_TOKEN_SECRET"
  | "MODAL_APP_NAME"
  // Daytona (Runtime Computer backend)
  | "DAYTONA_API_KEY"
  | "DAYTONA_API_URL"
  | "DAYTONA_TARGET"
  | "DAYTONA_SNAPSHOT"
  // Neev sandboxes (Runtime Computer backend)
  | "NEEV_API_KEY"
  | "NEEV_ORG_ID"
  | "NEEV_PROJECT_ID"
  | "NEEV_BASE_URL"
  | "NEEV_SANDBOX_TEMPLATE"
  // Cross-compiled runtime-agent binary uploaded on provision (decision 1A).
  | "RUNTIME_AGENT_BINARY_PATH"
  // Provider selection
  | "RUNTIME_PROVIDER"
  | "RUNTIME_BASE_URL"
  // Agent engine: "jcode" provisions a jcode box; unset/other = Claude Code.
  | "RUNTIME_ENGINE"
  // Where the control plane reads jcode credentials to inject (default ~/.jcode).
  | "JCODE_AUTH_DIR"
  // Inline base64 jcode credentials for a hosted control plane with no ~/.jcode.
  | "JCODE_AUTH_JSON"
  | "JCODE_AUTH_REFRESH_JSON";

export function optionalEnv(key: EnvKey): string | undefined {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

export function requireEnv(key: EnvKey): string {
  const value = optionalEnv(key);
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. See .env.example.`,
    );
  }
  return value;
}

/** Which RuntimeProvider implementation to use. */
export function providerName(): ProviderName {
  const provider = optionalEnv("RUNTIME_PROVIDER") ?? "local";
  if (provider === "local" || provider === "modal" || provider === "daytona" || provider === "neev") {
    return provider;
  }
  throw new Error(
    `Invalid RUNTIME_PROVIDER "${provider}". Expected "local", "modal", "daytona" or "neev".`,
  );
}
