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
  /** Who added it. Null once that account is gone (a team's project stays). */
  owner_id: string | null;
  /** The team (a workspace, in the UI) it belongs to. Left out on insert, the
   *  database puts it in the owner's personal team. */
  team_id: string;
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
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
};

type RuntimeComputerRow = {
  id: string;
  owner_id: string;
  project_id: string;
  status: RuntimeComputerStatusDb;
  image_version: string;
  daytona_sandbox_id: string | null;
  agent_base_url: string | null;
  agent_secret: string | null;
  provision_timings: Json | null;
  error_message: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
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

// Teams: workspaces people share (NEE-10). Written only through the functions
// below, which check the caller's role.
export type TeamRoleDb = "owner" | "admin" | "member" | "viewer";

type TeamRow = {
  id: string;
  name: string;
  personal: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type TeamMemberRow = {
  team_id: string;
  user_id: string;
  role: TeamRoleDb;
  created_at: string;
};

type TeamInviteRow = {
  id: string;
  team_id: string;
  role: TeamRoleDb;
  token_hash: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
};

type UserProfileRow = {
  user_id: string;
  github_login: string | null;
  avatar_url: string | null;
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
      attachments: {
        Row: AttachmentRow;
        Insert: Insert<
          AttachmentRow,
          "owner_id" | "filename" | "content_type" | "size_bytes" | "storage_path"
        >;
        Update: Partial<AttachmentRow>;
        Relationships: [];
      };
      user_credentials: {
        Row: UserCredentialsRow;
        Insert: Insert<UserCredentialsRow, "user_id">;
        Update: Partial<UserCredentialsRow>;
        Relationships: [];
      };
      teams: {
        Row: TeamRow;
        Insert: Insert<TeamRow, "name">;
        Update: Partial<TeamRow>;
        Relationships: [];
      };
      team_members: {
        Row: TeamMemberRow;
        Insert: Insert<TeamMemberRow, "team_id" | "user_id" | "role">;
        Update: Partial<TeamMemberRow>;
        Relationships: [];
      };
      team_invites: {
        Row: TeamInviteRow;
        Insert: Insert<TeamInviteRow, "team_id" | "role" | "token_hash" | "expires_at">;
        Update: Partial<TeamInviteRow>;
        Relationships: [];
      };
      user_profiles: {
        Row: UserProfileRow;
        Insert: Insert<UserProfileRow, "user_id">;
        Update: Partial<UserProfileRow>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      create_team: { Args: { team_name: string }; Returns: string };
      rename_team: { Args: { team: string; team_name: string }; Returns: undefined };
      create_team_invite: {
        Args: { team: string; invite_role: TeamRoleDb; token: string };
        Returns: string;
      };
      revoke_team_invite: { Args: { invite: string }; Returns: undefined };
      team_invite_preview: {
        Args: { token: string };
        Returns: Array<{ team_name: string; invite_role: TeamRoleDb }>;
      };
      accept_team_invite: { Args: { token: string }; Returns: string };
      set_team_member_role: {
        Args: { team: string; member: string; new_role: TeamRoleDb };
        Returns: undefined;
      };
      remove_team_member: { Args: { team: string; member: string }; Returns: undefined };
      delete_team: { Args: { team: string }; Returns: undefined };
      claim_runtime_computer: {
        Args: {
          requested_project_id: string;
          requested_agent_secret: string;
          requested_image_version?: string;
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
      team_role: TeamRoleDb;
    };
    CompositeTypes: Record<never, never>;
  };
};
