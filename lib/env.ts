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
  // Sign-in allowlist (blank means open sign-up)
  | "RUNTIME_OWNER_GITHUB_LOGIN"
  // Optional GitHub logins exempt from plan limits only (not an access allowlist).
  | "RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN"
  // Modal
  | "MODAL_TOKEN_ID"
  | "MODAL_TOKEN_SECRET"
  | "MODAL_APP_NAME"
  // Daytona (Runtime Computer backend)
  | "DAYTONA_API_KEY"
  | "DAYTONA_API_URL"
  | "DAYTONA_TARGET"
  | "DAYTONA_SNAPSHOT"
  // "1" where the Daytona account is this deployment's alone: the orphaned-box
  // sweep then deletes boxes from before they were labelled with it too.
  | "ORPHAN_SWEEP_UNLABELLED"
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
  // Bearer token the Cloudflare cron sends to POST /api/billing/reconcile.
  | "BILLING_CRON_SECRET"
  // Email through Resend (lib/email/send.ts), both optional: org invites and
  // requests to join. Without them, an invite's link is shown to share.
  | "RESEND_API_KEY"
  | "EMAIL_FROM"
  // The Outrunner GitHub App (lib/github/app.ts), all four or none: its
  // Client ID (the JWT's issuer), slug (its install link), private key (the
  // .pem) and webhook secret.
  | "GITHUB_APP_CLIENT_ID"
  | "GITHUB_APP_SLUG"
  | "GITHUB_APP_PRIVATE_KEY"
  | "GITHUB_APP_WEBHOOK_SECRET"
  // Dollars a month on Outrunner's models for each org's outrunner-connector,
  // which its automations run as (lib/billing/plans.ts connectorPlan).
  | "AUTOMATION_MODEL_ALLOWANCE_USD"
  // Stripe (RUNTIME_BILLING=stripe): a restricted or secret key, and the
  // webhook endpoint's signing secret.
  | "STRIPE_SECRET_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  // Slack app (triage capture): its signing secret, from the app's Basic
  // Information page. Unset turns /api/integrations/slack off.
  | "SLACK_SIGNING_SECRET"
  // The same app's Client ID and Client Secret (Basic Information): linking a
  // Slack user signs in with Slack. Unset, no one can link.
  | "SLACK_CLIENT_ID"
  | "SLACK_CLIENT_SECRET"
  // The Slack agent: the OpenRouter model it thinks with (default
  // anthropic/claude-sonnet-5.5). It runs on the org's key for Outrunner's
  // models, within the org's plan allowance.
  | "SLACK_AGENT_MODEL"
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
