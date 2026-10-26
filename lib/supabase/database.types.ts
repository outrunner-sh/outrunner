/**
 * Database types for the Runtime schema.
 *
 * Hand-maintained to match supabase/migrations/*.sql. Regenerate with:
 *   pnpm supabase gen types typescript --project-id <ref> > lib/supabase/database.types.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type WorkspaceStatusDb =
  | "creating"
  | "provisioning"
  | "ready"
  | "idle"
  | "suspending"
  | "resuming"
  | "suspended"
  | "destroying"
  | "destroyed"
  | "archiving"
  | "archived"
  | "restoring"
  | "failed";

export type ProvisionPhaseDb =
  | "allocate"
  | "clone"
  | "worktree"
  | "secrets"
  | "install"
  | "health_check"
  | "claude_ready";

export type JobStatusDb =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type JobAgentDb = "claude" | "codex";

export type RuntimeComputerStatusDb =
  | "provisioning"
  | "ready"
  | "error"
  | "stopped";

// M4 — Workspace Snapshot foundations.
export type ArchivePolicyDb =
  | "keep_forever"
  | "delete_after_n_days"
  | "manual_only";

export type LinearIssueRef = {
  id: string;
  identifier: string;
  title: string;
  url: string;
};

type ProjectRow = {
  id: string;
  owner_id: string;
  github_repo_id: number;
  full_name: string;
  owner: string;
  name: string;
  default_branch: string;
  is_private: boolean;
  language: string | null;
  description: string | null;
  html_url: string | null;
  pushed_at: string | null;
  linear_issues: LinearIssueRef[];
  hidden_at: string | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceRow = {
  id: string;
  owner_id: string;
  project_id: string;
  status: WorkspaceStatusDb;
  phase: ProvisionPhaseDb | null;
  branch: string;
  /** What the user first asked for; null until the first prompt. */
  title: string | null;
  base_branch: string;
  worktree_path: string | null;
  sandbox_id: string | null;
  volume_name: string | null;
  provider: string;
  install_command: string | null;
  error_message: string | null;
  computer_id: string | null;
  tmux_session: string | null;
  agent_workspace_id: string | null;
  /** The coding agent it runs: "claude" or "codex". */
  agent: string;
  /** The model it runs, whose it is, and its effort; null before the first
   *  is recorded. */
  model_provider: string | null;
  model_id: string | null;
  model_effort: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
};

type RuntimeComputerRow = {
  id: string;
  owner_id: string;
  project_id: string;
  /** The workspace whose own box it is; null for a project's shared box from
   *  before (20261023130000_workspace_computers.sql). */
  workspace_id: string | null;
  /** Made ready ahead of a session and stopped, for the next one to take
   *  (20261025120000_warm_pool.sql). */
  pooled: boolean;
  status: RuntimeComputerStatusDb;
  image_version: string;
  daytona_sandbox_id: string | null;
  agent_base_url: string | null;
  agent_secret: string | null;
  provision_timings: Json | null;
  error_message: string | null;
  last_active_at: string | null;
  /** The provider that made it; null from before it was recorded. */
  provider: string | null;
  created_at: string;
  updated_at: string;
};

/** A run of one of Outrunner's boxes (supabase/migrations/20261017120000_compute_metering.sql). */
type ComputeIntervalRow = {
  id: string;
  owner_id: string;
  computer_id: string | null;
  sandbox_id: string;
  cpu: number;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
};

type BillingCustomerRow = {
  user_id: string;
  stripe_customer_id: string;
  created_at: string;
};

/** A copy of a Stripe subscription (supabase/migrations/20261017150000_stripe_billing.sql). */
type SubscriptionRow = {
  stripe_subscription_id: string;
  user_id: string;
  stripe_customer_id: string;
  status: string;
  plan: string;
  price_lookup_key: string | null;
  billing_interval: string | null;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  past_due_since: string | null;
  synced_at: string;
  updated_at: string;
};

type StripeEventRow = {
  id: string;
  type: string;
  handled_at: string;
};

type BillingLeaseRow = {
  name: string;
  held_until: string;
};

type JobRow = {
  id: string;
  owner_id: string;
  workspace_id: string;
  agent: JobAgentDb;
  status: JobStatusDb;
  prompt: string;
  log_path: string | null;
  result_path: string | null;
  execution_handle: string | null;
  log_bytes: number;
  exit_code: number | null;
  session_id: string | null;
  cost_usd: number | null;
  linear_issue_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

type PullRequestRow = {
  id: string;
  owner_id: string;
  workspace_id: string;
  github_number: number;
  url: string;
  title: string;
  base_branch: string;
  head_branch: string;
  created_at: string;
};

// M4 — the DERIVED, owner-scoped index over Snapshot storage objects. `manifest`
// is a cached copy of the canonical manifest.json (jsonb, typed as Json here).
type WorkspaceSnapshotRow = {
  id: string;
  owner_id: string;
  workspace_id: string;
  archived_at: string;
  storage_path: string;
  manifest: Json;
  policy: ArchivePolicyDb;
  retention_days: number | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceImportRow = {
  owner_id: string;
  workspace_id: string;
  session_key: string;
  source: string;
  conversation_sha256: string;
  imported_at: string;
  created_at: string;
};

type ProjectEnvironmentRow = {
  owner_id: string;
  project_id: string;
  secrets_ciphertext: string | null;
  env_names: string[];
  file_paths: string[];
  setup_script: string | null;
  run_script: string | null;
  archive_script: string | null;
  created_at: string;
  updated_at: string;
};

type UserAgentConfigRow = {
  user_id: string;
  archive_path: string | null;
  archive_sha256: string | null;
  archive_size: number | null;
  items: string[];
  mcp_ciphertext: string | null;
  mcp_names: string[];
  settings: Json;
  created_at: string;
  updated_at: string;
};

// Multi-user — each user's own GitHub and Anthropic credentials, sealed with
// AES-256-GCM (lib/crypto/secret-box.ts). Service-role only: the table has RLS
// enabled with NO policy, so anon/authenticated match nothing. Reach it through
// lib/db/credentials.ts, never directly.
type UserCredentialsRow = {
  user_id: string;
  github_token_ciphertext: string | null;
  github_token_login: string | null;
  github_token_updated_at: string | null;
  anthropic_key_ciphertext: string | null;
  anthropic_key_hint: string | null;
  anthropic_key_updated_at: string | null;
  // Neev AI (supabase/migrations/20261007140000_neev_ai_keys.sql).
  neev_key_ciphertext: string | null;
  neev_key_hash: string | null;
  neev_key_created_at: string | null;
  // The allowance on it (supabase/migrations/20261017160000_model_allowance.sql).
  neev_allowance_period: string | null;
  neev_allowance_plan: string | null;
  neev_allowance_baseline_usd: number | null;
  neev_allowance_limit_usd: number | null;
  // Settings → Sandbox (supabase/migrations/20261013120000_user_sandbox.sql).
  sandbox: "outrunner" | "daytona" | "modal";
  daytona_key_ciphertext: string | null;
  daytona_key_hint: string | null;
  daytona_key_updated_at: string | null;
  // supabase/migrations/20261013140000_user_modal.sql.
  modal_token_ciphertext: string | null;
  modal_token_hint: string | null;
  modal_token_updated_at: string | null;
  // supabase/migrations/20261013130000_user_box_size.sql.
  box_size: "x-small" | "small" | "medium" | "large";
  // Settings → Providers (supabase/migrations/20261016140000_user_openrouter_key.sql).
  // Replaced by user_provider_keys; dropped in a later release.
  openrouter_key_ciphertext: string | null;
  openrouter_key_hint: string | null;
  openrouter_key_updated_at: string | null;
  created_at: string;
  updated_at: string;
};

// A user's own key for one model provider (Settings → Providers).
// Service-role-only (RLS on, no policies); see
// supabase/migrations/20261019120000_user_provider_keys.sql.
type UserProviderKeyRow = {
  user_id: string;
  provider: string;
  key_ciphertext: string;
  key_hint: string | null;
  created_at: string;
  updated_at: string;
};

// How a user's coding agent signs in (Settings → Providers). Service-role-only
// (RLS on, no policies); see supabase/migrations/20261020120000_user_agent_auth.sql.
type UserAgentAuthRow = {
  user_id: string;
  agent: string;
  method: string;
  created_at: string;
  updated_at: string;
};

// A user's model loadout (Settings → Default models). Service-role-only (RLS
// on, no policies); see supabase/migrations/20261020140000_user_model_loadout.sql.
type UserModelLoadoutRow = {
  user_id: string;
  models: Json;
  default_model: Json | null;
  created_at: string;
  updated_at: string;
};

// Per-user Claude Code credentials. Service-role-only (RLS on, no policies);
// see supabase/migrations/20260807000000_user_claude_credentials.sql.
type UserClaudeCredentialsRow = {
  owner_id: string;
  token_ciphertext: string;
  token_last4: string;
  created_at: string;
  updated_at: string;
};

// Composer attachments: a file uploaded with a prompt. workspace_id is null
// until the attachment is sent, because the home composer creates its workspace
// by sending — the file exists before any workspace does.
type AttachmentRow = {
  id: string;
  owner_id: string;
  workspace_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_path: string;
  materialized_at: string | null;
  created_at: string;
};

/** Columns the client may supply on insert (defaults fill the rest). */
// Signing in from the terminal (`outrunner login`): one-time codes the
// browser hands the CLI, and the tokens the CLI trades them for. Hashes only.
// Service-role only, like user_credentials (lib/db/cli-tokens.ts).
type CliLoginCodeRow = {
  code_hash: string;
  user_id: string;
  code_challenge: string;
  device_name: string;
  expires_at: string;
  created_at: string;
};

type CliTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  device_name: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

type Insert<Row, Required extends keyof Row> = Pick<Row, Required> &
  Partial<Omit<Row, Required | "created_at" | "updated_at">>;

export type Database = {
  public: {
    Tables: {
      projects: {
        Row: ProjectRow;
        Insert: Insert<
          ProjectRow,
          "owner_id" | "github_repo_id" | "full_name" | "owner" | "name"
        >;
        Update: Partial<ProjectRow>;
        Relationships: [];
      };
      user_claude_credentials: {
        Row: UserClaudeCredentialsRow;
        Insert: Insert<
          UserClaudeCredentialsRow,
          "owner_id" | "token_ciphertext" | "token_last4"
        >;
        Update: Partial<UserClaudeCredentialsRow>;
        Relationships: [];
      };
      workspaces: {
        Row: WorkspaceRow;
        Insert: Insert<WorkspaceRow, "owner_id" | "project_id" | "branch">;
        Update: Partial<WorkspaceRow>;
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_project_fkey";
            columns: ["owner_id", "project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["owner_id", "id"];
          },
          {
            foreignKeyName: "workspaces_computer_fkey";
            columns: ["owner_id", "computer_id"];
            isOneToOne: false;
            referencedRelation: "runtime_computers";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      runtime_computers: {
        Row: RuntimeComputerRow;
        Insert: Insert<RuntimeComputerRow, "owner_id" | "project_id">;
        Update: Partial<RuntimeComputerRow>;
        Relationships: [
          {
            foreignKeyName: "runtime_computers_owner_project_fkey";
            columns: ["owner_id", "project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      jobs: {
        Row: JobRow;
        Insert: Insert<JobRow, "owner_id" | "workspace_id" | "prompt">;
        Update: Partial<JobRow>;
        Relationships: [
          {
            foreignKeyName: "jobs_owner_workspace_fkey";
            columns: ["owner_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      pull_requests: {
        Row: PullRequestRow;
        Insert: Insert<
          PullRequestRow,
          "owner_id" | "workspace_id" | "github_number" | "url" | "title" | "base_branch" | "head_branch"
        >;
        Update: Partial<PullRequestRow>;
        Relationships: [
          {
            foreignKeyName: "pull_requests_owner_workspace_fkey";
            columns: ["owner_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      workspace_snapshots: {
        Row: WorkspaceSnapshotRow;
        Insert: Insert<
          WorkspaceSnapshotRow,
          "owner_id" | "workspace_id" | "archived_at" | "storage_path" | "manifest"
        >;
        Update: Partial<WorkspaceSnapshotRow>;
        Relationships: [
          {
            foreignKeyName: "workspace_snapshots_owner_workspace_fkey";
            columns: ["owner_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      user_agent_config: {
        Row: UserAgentConfigRow;
        Insert: Insert<UserAgentConfigRow, "user_id">;
        Update: Partial<UserAgentConfigRow>;
        Relationships: [];
      };
      project_environment: {
        Row: ProjectEnvironmentRow;
        Insert: Insert<ProjectEnvironmentRow, "owner_id" | "project_id">;
        Update: Partial<ProjectEnvironmentRow>;
        Relationships: [];
      };
      workspace_imports: {
        Row: WorkspaceImportRow;
        Insert: Insert<WorkspaceImportRow, "owner_id" | "workspace_id" | "session_key" | "source" | "conversation_sha256">;
        Update: Partial<WorkspaceImportRow>;
        Relationships: [
          {
            foreignKeyName: "workspace_imports_owner_workspace_fkey";
            columns: ["owner_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      attachments: {
        Row: AttachmentRow;
        Insert: Insert<
          AttachmentRow,
          "owner_id" | "filename" | "content_type" | "size_bytes" | "storage_path"
        >;
        Update: Partial<AttachmentRow>;
        Relationships: [];
      };
      cli_login_codes: {
        Row: CliLoginCodeRow;
        Insert: Insert<CliLoginCodeRow, "code_hash" | "user_id" | "code_challenge" | "device_name" | "expires_at">;
        Update: Partial<CliLoginCodeRow>;
        Relationships: [];
      };
      cli_tokens: {
        Row: CliTokenRow;
        Insert: Insert<CliTokenRow, "user_id" | "token_hash" | "device_name">;
        Update: Partial<CliTokenRow>;
        Relationships: [];
      };
      user_credentials: {
        Row: UserCredentialsRow;
        Insert: Insert<UserCredentialsRow, "user_id">;
        Update: Partial<UserCredentialsRow>;
        Relationships: [];
      };
      user_provider_keys: {
        Row: UserProviderKeyRow;
        Insert: Insert<UserProviderKeyRow, "user_id" | "provider" | "key_ciphertext">;
        Update: Partial<UserProviderKeyRow>;
        Relationships: [];
      };
      user_model_loadout: {
        Row: UserModelLoadoutRow;
        Insert: Insert<UserModelLoadoutRow, "user_id">;
        Update: Partial<UserModelLoadoutRow>;
        Relationships: [];
      };
      user_agent_auth: {
        Row: UserAgentAuthRow;
        Insert: Insert<UserAgentAuthRow, "user_id" | "agent" | "method">;
        Update: Partial<UserAgentAuthRow>;
        Relationships: [];
      };
      compute_intervals: {
        Row: ComputeIntervalRow;
        Insert: Insert<ComputeIntervalRow, "owner_id" | "sandbox_id" | "cpu">;
        Update: Partial<ComputeIntervalRow>;
        Relationships: [];
      };
      billing_customers: {
        Row: BillingCustomerRow;
        Insert: Insert<BillingCustomerRow, "user_id" | "stripe_customer_id">;
        Update: Partial<BillingCustomerRow>;
        Relationships: [];
      };
      subscriptions: {
        Row: SubscriptionRow;
        Insert: Insert<
          SubscriptionRow,
          | "stripe_subscription_id"
          | "user_id"
          | "stripe_customer_id"
          | "status"
          | "plan"
          | "current_period_start"
          | "current_period_end"
          | "synced_at"
        >;
        Update: Partial<SubscriptionRow>;
        Relationships: [];
      };
      stripe_events: {
        Row: StripeEventRow;
        Insert: Insert<StripeEventRow, "id" | "type">;
        Update: Partial<StripeEventRow>;
        Relationships: [];
      };
      billing_leases: {
        Row: BillingLeaseRow;
        Insert: BillingLeaseRow;
        Update: Partial<BillingLeaseRow>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      // supabase/migrations/20261019130000_move_claude_slot_key.sql
      move_claude_slot_key: {
        Args: { mover: string; sealed: string; hint: string };
        Returns: boolean;
      };
      claim_billing_lease: {
        Args: { lease_name: string; seconds: number };
        Returns: boolean;
      };
      claim_pooled_computer: {
        Args: { requested_workspace_id: string; requested_provider: string };
        Returns: string | null;
      };
      claim_workspace_computer: {
        Args: {
          requested_workspace_id: string;
          requested_agent_secret: string;
          requested_image_version?: string;
          /** The plan's cap on the owner's running boxes; null when none applies. */
          max_live_computers?: number | null;
        };
        Returns: Array<{
          runtime_computer_id: string;
          should_provision: boolean;
        }>;
      };
      claim_runtime_computer: {
        Args: {
          requested_project_id: string;
          requested_agent_secret: string;
          requested_image_version?: string;
          /** The plan's cap on the owner's running boxes; null when none applies. */
          max_live_computers?: number | null;
        };
        Returns: Array<{
          runtime_computer_id: string;
          should_provision: boolean;
        }>;
      };
    };
    Enums: {
      workspace_status: WorkspaceStatusDb;
      provision_phase: ProvisionPhaseDb;
      job_status: JobStatusDb;
      runtime_computer_status: RuntimeComputerStatusDb;
      archive_policy: ArchivePolicyDb;
    };
    CompositeTypes: Record<never, never>;
  };
};
