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

// supabase/migrations/20261030120000_work_items.sql
export type WorkItemStatusDb = "triage" | "todo" | "in_progress" | "done" | "declined" | "duplicate";
export type WorkItemSourceDb = "app" | "slack" | "cli" | "api";

// supabase/migrations/20261102120000_api_keys.sql
export type WorkspaceSourceDb = "app" | "slack" | "automation" | "github" | "api";

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
  /** The org it's in; given none, its owner's personal org
   *  (20261027120000_organizations.sql). */
  org_id: string;
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
  /** Its project's org, set from the project. */
  org_id: string;
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
  /** The environment (the app's Project) it started from; null for a
   *  session from before environments. */
  environment_id: string | null;
  /** A multi-repository session's repositories (20261028160000); null for
   *  one of one. */
  checkouts: Json | null;
  /** The coding agent it runs: "claude" or "codex". */
  agent: string;
  /** The model it runs, whose it is, and its effort; null before the first
   *  is recorded. */
  model_provider: string | null;
  model_id: string | null;
  model_effort: string | null;
  /** Absent before the migration that adds it; null is build. */
  session_mode?: "build" | "plan" | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
  /** Run by the server out of sight (a Slack thread's research): not listed. */
  background: boolean;
  /** The idempotency key its first prompt was claimed under, when, and when
   *  it reached the box (20261031190000); null until one is. */
  first_prompt_key: string | null;
  first_prompt_claimed_at: string | null;
  first_prompt_sent_at: string | null;
  /** The Slack thread it was started from (20261031200000). */
  slack_thread_url: string | null;
  slack_sync: boolean;
  /** Where it came from (20261102120000_api_keys.sql). */
  source: WorkspaceSourceDb;
  /** When its status last turned failed (20261102163000); null otherwise. */
  failed_at?: string | null;
  /** A session, or a Mission (20261102200000_missions.sql). */
  kind: "session" | "mission";
  /** The Mission a Runner works for; null for any other session. */
  parent_mission_id: string | null;
};

// supabase/migrations/20261102200000_missions.sql
type MissionTokenRow = { mission_id: string; token_hash: string; minted_at: string };
type MissionRunnerBriefRow = { runner_id: string; mission_id: string; brief: string; created_at: string };
type MissionNotesRow = { mission_id: string; body: string; updated_at: string };
export type MissionEventKind = "finished" | "ready" | "needs_attention" | "merged" | "closed" | "archived";
type MissionEventRow = {
  id: string;
  mission_id: string;
  runner_id: string;
  kind: MissionEventKind;
  payload: Json;
  idempotency_key: string;
  created_at: string;
  delivery_id: string | null;
  delivered_at: string | null;
};
// supabase/migrations/20261102250000_mission_events.sql
type TurnWatchRow = {
  workspace_id: string;
  purpose: "runner";
  sent_at: string;
  baseline_activity: string | null;
  seen_working: boolean;
  quiet_since: string | null;
  quiet_activity: string | null;
  last_message: string | null;
  unreachable_since: string | null;
  exited_since: string | null;
  up_since: string | null;
  checked_at: string | null;
};
type RunnerPullRequestRow = {
  runner_id: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  head_ref: string;
  base_ref: string | null;
  head_sha: string | null;
  state: "open" | "merged" | "closed";
  first_activity_at: string;
  last_activity_at: string;
  verdict: "ready" | "needs_attention" | null;
  verdict_reason: string | null;
  reported_verdict: string | null;
  reported_sha: string | null;
  decision_seq: number;
  additions: number | null;
  deletions: number | null;
  checks: Json;
  review_state: "approved" | "changes_requested" | "none" | null;
  mergeable_state: string | null;
  checked_at: string | null;
  created_at: string;
};
// supabase/migrations/20261102260000_mission_profiles.sql
type MissionProfileRow = { mission_id: string; icon: string | null; position: number | null; updated_at: string };
type MissionDeliveryRow = {
  id: string;
  mission_id: string;
  attempts: number;
  lease_until: string | null;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
};
type MissionQueuedMessageRow = {
  id: string;
  mission_id: string;
  runner_id: string;
  content: string;
  created_at: string;
  sent_at: string | null;
};

type RuntimeComputerRow = {
  id: string;
  /** Its project's org, set from the project. */
  org_id: string;
  owner_id: string;
  project_id: string;
  /** The workspace whose own box it is; null for a project's shared box from
   *  before (20261023130000_workspace_computers.sql). */
  workspace_id: string | null;
  /** Made ready ahead of a session and stopped, for the next one to take
   *  (20261025120000_warm_pool.sql). */
  pooled: boolean;
  /** Which of the project's two ready boxes it is (20261028150000_warm_hooks.sql). */
  pool_slot: number;
  /** The project's setup_generation it was made from. */
  generation: number | null;
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
  /** The org the box ran for, whose hours they are (20261031150000_org_billing.sql). */
  org_id: string | null;
  computer_id: string | null;
  sandbox_id: string;
  cpu: number;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
};

type BillingCustomerRow = {
  /** The org it bills (20261031150000_org_billing.sql); the user who made it. */
  org_id: string;
  user_id: string | null;
  stripe_customer_id: string;
  created_at: string;
};

/** A copy of a Stripe subscription (supabase/migrations/20261017150000_stripe_billing.sql). */
type SubscriptionRow = {
  stripe_subscription_id: string;
  /** The org whose plan it is (20261031150000_org_billing.sql); who bought it. */
  org_id: string;
  user_id: string | null;
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

/** A prompt a user sent, for the composer to recall (20261102230000, or
 *  20261102270000 where the former was recorded before its correction). */
type ComposerPromptHistoryRow = {
  id: number;
  owner_id: string;
  text: string;
  created_at: string;
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
  /** The repository it's in (20261028170000). */
  project_id: string;
  github_number: number;
  url: string;
  title: string;
  base_branch: string;
  head_branch: string;
  created_at: string;
  /** As GitHub last said (20261102160000), and since when. */
  state: "open" | "closed" | "merged";
  state_at: string | null;
  checked_at: string | null;
};

// supabase/migrations/20261102160000_session_standing.sql
type SessionActivityRow = {
  workspace_id: string;
  owner_id: string;
  turn: "working" | "idle";
  turn_started_at: string | null;
  waiting: "question" | "plan" | "secrets" | null;
  waiting_tool_id: string | null;
  waiting_since: string | null;
  replied_at: string | null;
  reply_preview: string | null;
  event_at: string | null;
  stream_cursor: number;
  stream_box: string | null;
  watch_until: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
};

// supabase/migrations/20261102163000_session_notifications.sql
export type NotificationKindDb = "turn_done" | "needs_input" | "errored" | "pr_opened" | "pr_merged" | "pr_ready";

type SessionNotificationRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  kind: NotificationKindDb;
  event_key: string;
  title: string;
  body: string;
  created_at: string;
  emailed_at: string | null;
  slacked_at: string | null;
};

type NotificationPreferencesRow = {
  user_id: string;
  browser: boolean;
  email: "off" | "instant" | "digest";
  slack: boolean;
  kinds: NotificationKindDb[];
  digest_sent_at: string | null;
  digest_retry_at: string | null;
  updated_at: string;
};

type SessionMarkRow = {
  user_id: string;
  workspace_id: string;
  pinned_at: string | null;
  moved_to: "needs_you" | "working" | "in_review" | "done" | "backlog" | null;
  moved_at: string | null;
  seen_at: string | null;
  updated_at: string;
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

/** What the app calls a Project (20261027121000_environments.sql). */
type EnvironmentRow = {
  id: string;
  /** Its org (20261028140000_org_environments.sql): its repository's, for a
   *  repository's default; given none, its maker's personal org. */
  org_id: string;
  /** Who made it. */
  owner_id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  secrets_ciphertext: string | null;
  env_names: string[];
  file_paths: string[];
  setup_script: string | null;
  run_script: string | null;
  archive_script: string | null;
  default_for_project_id: string | null;
  archived_at: string | null;
  warm_hook: string | null;
  start_hook: string | null;
  setup_generation: number;
  /** Each member's last warm run, by user id (20261028150000_warm_hooks.sql). */
  warm_runs: Json;
  created_at: string;
  updated_at: string;
};

type EnvironmentRepoRow = {
  /** Its project's org, set from the project. */
  org_id: string;
  owner_id: string;
  environment_id: string;
  project_id: string;
  checkout_name: string;
  branch: string | null;
  position: number;
  created_at: string;
};

/** A skills.sh catalog skill enabled on a project
 *  (20261103130000_environment_skills.sql). */
type EnvironmentSkillRow = {
  id: string;
  /** Its project's org, set from the project. */
  org_id: string;
  environment_id: string;
  slug: string;
  name: string;
  source: string;
  skill: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** A GitHub repository whose skills a project's sessions get. */
type EnvironmentSkillRegistryRow = {
  id: string;
  org_id: string;
  environment_id: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  created_by: string | null;
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
  // supabase/migrations/20261030150000_org_defaults.sql.
  box_size_chosen: boolean;
  // Settings → Account (supabase/migrations/20261030100000_github_identity.sql).
  github_identity: "personal" | "app";
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
// An org's keys for model providers (Settings → Org → Keys). Service-role-only;
// see supabase/migrations/20261030115000_org_provider_keys.sql.
// A team org's key and allowance on Outrunner's models; see
// supabase/migrations/20261031175000_org_model_allowance.sql.
type OrgModelAllowanceRow = {
  org_id: string;
  key_ciphertext: string | null;
  key_hash: string | null;
  key_created_at: string | null;
  allowance_period: string | null;
  allowance_plan: string | null;
  allowance_baseline_usd: number | null;
  allowance_limit_usd: number | null;
  created_at: string;
};

// An org's audit log, append-only; see
// supabase/migrations/20261101115000_audit_events.sql.
type AuditEventRow = {
  id: number;
  org_id: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_label: string | null;
  details: Json;
  created_at: string;
};

// Each usage alert sent to an org's admins, once per period and threshold;
// see supabase/migrations/20261101100000_org_usage_controls.sql.
type OrgUsageAlertRow = {
  org_id: string;
  period_start: string;
  threshold: number;
  sent_at: string;
};

// An org's defaults for its members' new sessions (Settings → Org →
// Defaults); see supabase/migrations/20261030150000_org_defaults.sql.
type OrganizationSettingsRow = {
  org_id: string;
  default_model: Json | null;
  box_size: "x-small" | "small" | "medium" | "large" | null;
  // supabase/migrations/20261101100000_org_usage_controls.sql.
  usage_limit_percent: number | null;
  alert_thresholds: number[];
  // supabase/migrations/20261102100000_github_agent_loop.sql.
  archive_on_close: boolean;
  updated_by: string | null;
  updated_at: string;
};

// An org's Doppler and Infisical connections, and the projects linked to
// them; see supabase/migrations/20261103140000_secret_sync.sql.
type OrgSecretIntegrationRow = {
  id: string;
  org_id: string;
  provider: "doppler" | "infisical";
  credentials_ciphertext: string;
  settings: Json;
  label: string;
  connected_by: string | null;
  created_at: string;
  updated_at: string;
};

type EnvironmentSecretLinkRow = {
  environment_id: string;
  integration_id: string;
  org_id: string;
  provider: "doppler" | "infisical";
  settings: Json;
  linked_by: string | null;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
  last_error: string | null;
  last_warning: string | null;
  last_names: string[];
  last_skipped: string[];
};

type OrgProviderKeyRow = {
  org_id: string;
  provider: string;
  key_ciphertext: string;
  key_hint: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

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

// supabase/migrations/20261103170000_media.sql
type MediaRow = {
  id: string;
  public_id: string;
  org_id: string;
  owner_id: string;
  workspace_id: string | null;
  name: string;
  content_type: string;
  size_bytes: number;
  access: "public" | "private";
  storage_path: string;
  status: "pending" | "ready";
  created_at: string;
  ready_at: string | null;
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

type OrganizationRow = {
  id: string;
  name: string;
  /** Set on a user's personal org, and only there. */
  personal_owner_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type OrgRoleDb = "admin" | "member";

type OrganizationMemberRow = {
  org_id: string;
  user_id: string;
  role: OrgRoleDb;
  created_at: string;
};

export type AutomationTriggerDb =
  | "pull_request.opened"
  | "pull_request.synchronize"
  | "pull_request.closed"
  | "pull_request.merged"
  | "pull_request.review_requested"
  | "issues.opened"
  | "issues.labeled"
  | "schedule"
  | "webhook";

type AutomationRow = {
  id: string;
  org_id: string;
  runs_as: string | null;
  name: string;
  template: string | null;
  prompt: string;
  triggers: AutomationTriggerDb[];
  enabled: boolean;
  /** Its webhook's token: hashed, to find it by, and sealed, to show it
   *  again (supabase/migrations/20261102195000_automation_webhooks.sql). */
  webhook_token_hash: string | null;
  webhook_token_sealed: string | null;
  /** supabase/migrations/20261102198000_automation_limits.sql */
  reviewers: string[];
  labels: string[];
  max_runs: number | null;
  archive_when_done: boolean;
  debounce_seconds: number;
  session_mode: "new" | "reuse";
  archived_at: string | null;
  runs_since: string;
  created_at: string;
  updated_at: string;
};

export type AutomationRunStatusDb = "queued" | "started" | "ready" | "failed" | "refused";

type AutomationRunRow = {
  id: string;
  automation_id: string;
  project_id: string;
  /** A pull request's run's; null for any other (supabase/migrations/20261102190000_automation_schedules.sql). */
  pr_number: number | null;
  pr_title: string;
  head_sha: string | null;
  /** Null for a run from before triggers were kept. */
  trigger: AutomationTriggerDb | null;
  dedupe_key: string;
  scheduled_for: string | null;
  context: Json | null;
  /** An issue's run's (supabase/migrations/20261102198000_automation_limits.sql). */
  issue_number: number | null;
  /** What a debounce window combines on: a pull request, an issue, the
   *  schedule, the webhook. */
  subject: string | null;
  /** A queued run's: when its window ends. */
  not_before: string | null;
  combined: number;
  /** The keys of the triggers a debounce window took into it. */
  absorbed_keys: string[];
  workspace_id: string | null;
  status: AutomationRunStatusDb;
  reason: string | null;
  /** Its check on the pull request (20261101120000_automation_run_checks.sql). */
  check_run_id: number | null;
  check_installation_id: number | null;
  check_closed_at: string | null;
  check_reviewed_at: string | null;
  /** How the review closes the check: { conclusion, output }. */
  check_review: Json | null;
  created_at: string;
  updated_at: string;
};

type GithubSessionLinkRow = {
  project_id: string;
  kind: "issue" | "pull";
  number: number;
  workspace_id: string;
  created_at: string;
};

type GithubFollowUpRow = {
  id: string;
  kind: "ci" | "review";
  installation_id: number;
  project_id: string;
  repo_full_name: string;
  pr_number: number;
  head_sha: string;
  review_ids: number[];
  first_at: string;
  due_at: string;
  sent_at: string | null;
  outcome: string | null;
  created_at: string;
};

type AutomationRepoRow = {
  automation_id: string;
  project_id: string;
};

export type AutomationScheduleKindDb = "weekly" | "monthly" | "once" | "cron";

type AutomationScheduleRow = {
  id: string;
  automation_id: string;
  position: number;
  kind: AutomationScheduleKindDb;
  timezone: string;
  spec: Json;
  next_run_at: string | null;
  created_at: string;
};

type OrganizationDomainRow = {
  domain: string;
  org_id: string;
  claimed_by: string | null;
  created_at: string;
};

type OrganizationInviteRow = {
  id: string;
  org_id: string;
  email: string;
  role: OrgRoleDb;
  token_hash: string;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
};

export type JoinRequestStatusDb = "pending" | "approved" | "declined" | "cancelled";

type OrganizationJoinRequestRow = {
  id: string;
  org_id: string;
  user_id: string;
  email: string;
  status: JoinRequestStatusDb;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

type OrganizationRemovalRow = {
  org_id: string;
  user_id: string;
  removed_by: string | null;
  removed_at: string;
};

type OrganizationRoleRow = {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type MemberRoleRow = {
  org_id: string;
  user_id: string;
  role_id: string;
};

export type AccessLevelDb = "read" | "write";

type AccessGrantRow = {
  id: string;
  org_id: string;
  /** Null: Everyone in the org. */
  role_id: string | null;
  /** Null: all the org's projects. */
  project_id: string | null;
  level: AccessLevelDb;
  created_at: string;
};

type GithubInstallationRow = {
  installation_id: number;
  /** Null until its installer claims it for an org (20261029110000). */
  org_id: string | null;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  installed_by: string | null;
  /** The GitHub user who installed it (the webhook's sender), by numeric
   *  id: what a claim is matched by. */
  installer_id: number | null;
  /** Their login then, for showing. */
  installer_login: string | null;
  /** The org that removed it (unclaimed it): the only one it goes back to. */
  removed_from: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
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

// supabase/migrations/20261102120000_api_keys.sql
type ApiKeyRow = {
  id: string;
  /** An org key's org; null for a personal key. */
  org_id: string | null;
  /** Who made it, and so who it acts as. */
  user_id: string;
  name: string;
  key_hash: string;
  hint: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
};

type ApiRequestRow = {
  id: number;
  key_id: string | null;
  cli_token_id: string | null;
  user_id: string;
  org_id: string | null;
  method: string;
  path: string;
  status: number;
  created_at: string;
};

// supabase/migrations/20261102130000_api_webhooks.sql
export type WebhookScopeDb = "org" | "user";
export type WebhookEventDb = "workspace.ready" | "turn.completed" | "needs_input" | "pr.opened" | "error";

type ApiWebhookSettingsRow = {
  scope: WebhookScopeDb;
  scope_id: string;
  url: string | null;
  secret_ciphertext: string;
  updated_by: string | null;
  updated_at: string;
};

type ApiWatchRow = {
  workspace_id: string;
  org_id: string;
  user_id: string;
  scope: WebhookScopeDb;
  scope_id: string;
  webhook_url: string | null;
  awaiting: boolean;
  seen_working: boolean;
  baseline_event: string | null;
  baseline_fenced: boolean;
  asked_tool_use: string | null;
  told_prs: string[];
  watch_until: string | null;
  checked_at: string | null;
  created_at: string;
};

type ApiWebhookDeliveryRow = {
  id: string;
  scope: WebhookScopeDb;
  scope_id: string;
  workspace_id: string | null;
  event: WebhookEventDb;
  url: string;
  payload: Json;
  attempts: number;
  next_attempt_at: string | null;
  delivered_at: string | null;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
};

type WorkItemRow = {
  id: string;
  org_id: string;
  created_by: string | null;
  project_id: string | null;
  number: number;
  title: string;
  body: string;
  status: WorkItemStatusDb;
  source: WorkItemSourceDb;
  source_url: string | null;
  source_ref: string | null;
  duplicate_of: string | null;
  workspace_id: string | null;
  triaged_at: string | null;
  prompt: string | null;
  slack_nudged_at: string | null;
  created_at: string;
  updated_at: string;
};

type WorkItemNoteRow = {
  id: string;
  org_id: string;
  item_id: string;
  author_id: string | null;
  body: string;
  source: WorkItemSourceDb;
  source_url: string | null;
  author: string | null;
  created_at: string;
};

type SlackLinkRow = {
  team_id: string;
  slack_user_id: string;
  owner_id: string;
  org_id: string;
  team_name: string | null;
  slack_user_name: string | null;
  created_at: string;
};

// supabase/migrations/20261031100000_slack_agent.sql
type SlackInstallationRow = {
  team_id: string;
  team_name: string | null;
  bot_user_id: string;
  bot_token_ciphertext: string;
  created_at: string;
  updated_at: string;
};

type SlackConversationRow = {
  id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  org_id: string;
  started_by: string | null;
  state: "gathering" | "proposed" | "filed" | "started";
  rounds: number;
  proposal: Json | null;
  proposal_ts: string | null;
  item_id: string | null;
  workspace_id: string | null;
  research_workspace_id: string | null;
  pr_repo: string | null;
  pr_number: number | null;
  pr_url: string | null;
  verdict_comment_id: number | null;
  merged_announced: boolean;
  pr_checked_at: string | null;
  relayed_hash: string | null;
  relay_until: string | null;
  created_at: string;
  updated_at: string;
};

// supabase/migrations/20261031170000_slack_proactive.sql
type SlackChannelRow = {
  team_id: string;
  channel_id: string;
  org_id: string;
  set_by: string | null;
  watch: boolean;
  digest: "daily" | "weekly" | null;
  digest_hour: number;
  digest_tz: string;
  last_digest_on: string | null;
  created_at: string;
  updated_at: string;
};

// supabase/migrations/20261031110000_slack_research.sql
type SlackResearchRow = {
  id: string;
  conversation_id: string;
  workspace_id: string | null;
  asked_by: string | null;
  question: string;
  token_hash: string;
  status: "asked" | "answered" | "failed";
  created_at: string;
  answered_at: string | null;
};

type SlackEventSeenRow = { event_id: string; created_at: string };

type OrgModelKeyRow = {
  org_id: string;
  key_ciphertext: string | null;
  key_hash: string | null;
  created_at: string;
};

type Insert<Row, Required extends keyof Row> = Pick<Row, Required> &
  Partial<Omit<Row, Required | "created_at" | "updated_at">>;

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: OrganizationRow;
        Insert: Insert<OrganizationRow, "name">;
        Update: Partial<OrganizationRow>;
        Relationships: [];
      };
      organization_domains: {
        Row: OrganizationDomainRow;
        Insert: Insert<OrganizationDomainRow, "domain" | "org_id">;
        Update: Partial<OrganizationDomainRow>;
        Relationships: [];
      };
      automations: {
        Row: AutomationRow;
        Insert: Insert<AutomationRow, "org_id" | "name" | "prompt" | "triggers">;
        Update: Partial<AutomationRow>;
        Relationships: [];
      };
      org_connectors: {
        Row: { org_id: string; user_id: string; created_at: string };
        Insert: { org_id: string; user_id: string };
        Update: Partial<{ org_id: string; user_id: string }>;
        Relationships: [];
      };
      review_sessions: {
        Row: { workspace_id: string; created_at: string };
        Insert: { workspace_id: string };
        Update: Partial<{ workspace_id: string }>;
        Relationships: [];
      };
      // supabase/migrations/20261102100000_github_agent_loop.sql
      github_loop_claims: {
        Row: { key: string; created_at: string };
        Insert: { key: string };
        Update: Partial<{ key: string }>;
        Relationships: [];
      };
      github_session_links: {
        Row: GithubSessionLinkRow;
        Insert: Insert<GithubSessionLinkRow, "project_id" | "kind" | "number" | "workspace_id">;
        Update: Partial<GithubSessionLinkRow>;
        Relationships: [];
      };
      // supabase/migrations/20261102110000_github_followups.sql
      github_followups: {
        Row: GithubFollowUpRow;
        Insert: Insert<GithubFollowUpRow, "kind" | "installation_id" | "project_id" | "repo_full_name" | "pr_number" | "due_at">;
        Update: Partial<GithubFollowUpRow>;
        Relationships: [];
      };
      github_pr_loops: {
        Row: { project_id: string; pr_number: number; ci_turns: number; updated_at: string };
        Insert: { project_id: string; pr_number: number; ci_turns?: number };
        Update: Partial<{ ci_turns: number; updated_at: string }>;
        Relationships: [];
      };
      automation_runs: {
        Row: AutomationRunRow;
        Insert: Insert<AutomationRunRow, "automation_id" | "project_id" | "dedupe_key">;
        Update: Partial<AutomationRunRow>;
        Relationships: [];
      };
      automation_repos: {
        Row: AutomationRepoRow;
        Insert: AutomationRepoRow;
        Update: Partial<AutomationRepoRow>;
        Relationships: [];
      };
      automation_schedules: {
        Row: AutomationScheduleRow;
        Insert: Insert<AutomationScheduleRow, "automation_id" | "kind" | "timezone" | "spec">;
        Update: Partial<AutomationScheduleRow>;
        Relationships: [];
      };
      organization_invites: {
        Row: OrganizationInviteRow;
        Insert: Insert<OrganizationInviteRow, "org_id" | "email" | "role" | "token_hash" | "expires_at">;
        Update: Partial<OrganizationInviteRow>;
        Relationships: [];
      };
      organization_join_requests: {
        Row: OrganizationJoinRequestRow;
        Insert: Insert<OrganizationJoinRequestRow, "org_id" | "user_id" | "email">;
        Update: Partial<OrganizationJoinRequestRow>;
        Relationships: [];
      };
      organization_removals: {
        Row: OrganizationRemovalRow;
        Insert: Insert<OrganizationRemovalRow, "org_id" | "user_id">;
        Update: Partial<OrganizationRemovalRow>;
        Relationships: [];
      };
      organization_roles: {
        Row: OrganizationRoleRow;
        Insert: Insert<OrganizationRoleRow, "org_id" | "name">;
        Update: Partial<OrganizationRoleRow>;
        Relationships: [];
      };
      member_roles: {
        Row: MemberRoleRow;
        Insert: MemberRoleRow;
        Update: Partial<MemberRoleRow>;
        Relationships: [];
      };
      access_grants: {
        Row: AccessGrantRow;
        Insert: Insert<AccessGrantRow, "org_id" | "level">;
        Update: Partial<AccessGrantRow>;
        Relationships: [];
      };
      github_installations: {
        Row: GithubInstallationRow;
        Insert: Insert<GithubInstallationRow, "installation_id" | "account_login" | "account_type" | "repository_selection">;
        Update: Partial<GithubInstallationRow>;
        Relationships: [];
      };
      organization_members: {
        Row: OrganizationMemberRow;
        Insert: Insert<OrganizationMemberRow, "org_id" | "user_id" | "role">;
        Update: Partial<OrganizationMemberRow>;
        Relationships: [];
      };
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
            foreignKeyName: "workspaces_org_project_fkey";
            columns: ["org_id", "project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["org_id", "id"];
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
            foreignKeyName: "runtime_computers_org_project_fkey";
            columns: ["org_id", "project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["org_id", "id"];
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
      environments: {
        Row: EnvironmentRow;
        Insert: Insert<EnvironmentRow, "owner_id" | "name">;
        Update: Partial<EnvironmentRow>;
        Relationships: [];
      };
      environment_repos: {
        Row: EnvironmentRepoRow;
        Insert: Insert<EnvironmentRepoRow, "owner_id" | "environment_id" | "project_id" | "checkout_name">;
        Update: Partial<EnvironmentRepoRow>;
        Relationships: [];
      };
      environment_skills: {
        Row: EnvironmentSkillRow;
        Insert: Insert<EnvironmentSkillRow, "environment_id" | "slug" | "name" | "source" | "skill">;
        Update: Partial<EnvironmentSkillRow>;
        Relationships: [];
      };
      environment_skill_registries: {
        Row: EnvironmentSkillRegistryRow;
        Insert: Insert<EnvironmentSkillRegistryRow, "environment_id" | "full_name" | "default_branch">;
        Update: Partial<EnvironmentSkillRegistryRow>;
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
      media: {
        Row: MediaRow;
        Insert: Insert<
          MediaRow,
          "public_id" | "org_id" | "owner_id" | "name" | "content_type" | "size_bytes" | "storage_path"
        >;
        Update: Partial<MediaRow>;
        Relationships: [];
      };
      cli_login_codes: {
        Row: CliLoginCodeRow;
        Insert: Insert<CliLoginCodeRow, "code_hash" | "user_id" | "code_challenge" | "device_name" | "expires_at">;
        Update: Partial<CliLoginCodeRow>;
        Relationships: [];
      };
      work_items: {
        Row: WorkItemRow;
        Insert: Insert<WorkItemRow, "org_id" | "title">;
        Update: Partial<WorkItemRow>;
        Relationships: [];
      };
      work_item_notes: {
        Row: WorkItemNoteRow;
        Insert: Insert<WorkItemNoteRow, "org_id" | "item_id" | "body">;
        Update: Partial<WorkItemNoteRow>;
        Relationships: [];
      };
      slack_installations: {
        Row: SlackInstallationRow;
        Insert: Insert<SlackInstallationRow, "team_id" | "bot_user_id" | "bot_token_ciphertext">;
        Update: Partial<SlackInstallationRow>;
        Relationships: [];
      };
      slack_conversations: {
        Row: SlackConversationRow;
        Insert: Insert<SlackConversationRow, "team_id" | "channel_id" | "thread_ts" | "org_id">;
        Update: Partial<SlackConversationRow>;
        Relationships: [];
      };
      slack_channels: {
        Row: SlackChannelRow;
        Insert: Insert<SlackChannelRow, "team_id" | "channel_id" | "org_id">;
        Update: Partial<SlackChannelRow>;
        Relationships: [];
      };
      mission_tokens: {
        Row: MissionTokenRow;
        Insert: Insert<MissionTokenRow, "mission_id" | "token_hash">;
        Update: Partial<MissionTokenRow>;
        Relationships: [];
      };
      mission_runner_briefs: {
        Row: MissionRunnerBriefRow;
        Insert: Insert<MissionRunnerBriefRow, "runner_id" | "mission_id" | "brief">;
        Update: Partial<MissionRunnerBriefRow>;
        Relationships: [];
      };
      mission_notes: {
        Row: MissionNotesRow;
        Insert: Insert<MissionNotesRow, "mission_id">;
        Update: Partial<MissionNotesRow>;
        Relationships: [];
      };
      mission_events: {
        Row: MissionEventRow;
        Insert: Insert<MissionEventRow, "mission_id" | "runner_id" | "kind" | "idempotency_key">;
        Update: Partial<MissionEventRow>;
        Relationships: [];
      };
      turn_watches: {
        Row: TurnWatchRow;
        Insert: Insert<TurnWatchRow, "workspace_id" | "purpose" | "sent_at">;
        Update: Partial<TurnWatchRow>;
        Relationships: [];
      };
      runner_pull_requests: {
        Row: RunnerPullRequestRow;
        Insert: Insert<RunnerPullRequestRow, "runner_id" | "repo" | "number" | "url" | "head_ref">;
        Update: Partial<RunnerPullRequestRow>;
        Relationships: [];
      };
      mission_profiles: {
        Row: MissionProfileRow;
        Insert: Insert<MissionProfileRow, "mission_id">;
        Update: Partial<MissionProfileRow>;
        Relationships: [];
      };
      mission_deliveries: {
        Row: MissionDeliveryRow;
        Insert: Insert<MissionDeliveryRow, "mission_id">;
        Update: Partial<MissionDeliveryRow>;
        Relationships: [];
      };
      mission_queued_messages: {
        Row: MissionQueuedMessageRow;
        Insert: Insert<MissionQueuedMessageRow, "mission_id" | "runner_id" | "content">;
        Update: Partial<MissionQueuedMessageRow>;
        Relationships: [];
      };
      slack_research: {
        Row: SlackResearchRow;
        Insert: Insert<SlackResearchRow, "conversation_id" | "question" | "token_hash">;
        Update: Partial<SlackResearchRow>;
        Relationships: [];
      };
      slack_events_seen: {
        Row: SlackEventSeenRow;
        Insert: Insert<SlackEventSeenRow, "event_id">;
        Update: Partial<SlackEventSeenRow>;
        Relationships: [];
      };
      org_model_keys: {
        Row: OrgModelKeyRow;
        Insert: Insert<OrgModelKeyRow, "org_id">;
        Update: Partial<OrgModelKeyRow>;
        Relationships: [];
      };
      session_activity: {
        Row: SessionActivityRow;
        Insert: Insert<SessionActivityRow, "workspace_id" | "owner_id"> & Partial<Pick<SessionActivityRow, "updated_at">>;
        Update: Partial<SessionActivityRow>;
        Relationships: [];
      };
      session_marks: {
        Row: SessionMarkRow;
        Insert: Insert<SessionMarkRow, "user_id" | "workspace_id"> & Partial<Pick<SessionMarkRow, "updated_at">>;
        Update: Partial<SessionMarkRow>;
        Relationships: [];
      };
      session_notifications: {
        Row: SessionNotificationRow;
        Insert: Insert<SessionNotificationRow, "user_id" | "workspace_id" | "kind" | "event_key" | "title" | "body">;
        Update: Partial<SessionNotificationRow>;
        Relationships: [];
      };
      notification_preferences: {
        Row: NotificationPreferencesRow;
        Insert: Insert<NotificationPreferencesRow, "user_id"> & Partial<Pick<NotificationPreferencesRow, "updated_at">>;
        Update: Partial<NotificationPreferencesRow>;
        Relationships: [];
      };
      slack_links: {
        Row: SlackLinkRow;
        Insert: Insert<SlackLinkRow, "team_id" | "slack_user_id" | "owner_id" | "org_id">;
        Update: Partial<SlackLinkRow>;
        Relationships: [];
      };
      api_keys: {
        Row: ApiKeyRow;
        Insert: Insert<ApiKeyRow, "user_id" | "name" | "key_hash" | "hint">;
        Update: Partial<ApiKeyRow>;
        Relationships: [];
      };
      api_requests: {
        Row: ApiRequestRow;
        Insert: Insert<ApiRequestRow, "user_id" | "method" | "path" | "status">;
        Update: Partial<ApiRequestRow>;
        Relationships: [];
      };
      api_webhook_settings: {
        Row: ApiWebhookSettingsRow;
        Insert: Insert<ApiWebhookSettingsRow, "scope" | "scope_id" | "secret_ciphertext">;
        Update: Partial<ApiWebhookSettingsRow>;
        Relationships: [];
      };
      api_watches: {
        Row: ApiWatchRow;
        Insert: Insert<ApiWatchRow, "workspace_id" | "org_id" | "user_id" | "scope" | "scope_id">;
        Update: Partial<ApiWatchRow>;
        Relationships: [];
      };
      api_webhook_deliveries: {
        Row: ApiWebhookDeliveryRow;
        Insert: Insert<ApiWebhookDeliveryRow, "scope" | "scope_id" | "event" | "url" | "payload">;
        Update: Partial<ApiWebhookDeliveryRow>;
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
      org_model_allowance: {
        Row: OrgModelAllowanceRow;
        Insert: Insert<OrgModelAllowanceRow, "org_id">;
        Update: Partial<OrgModelAllowanceRow>;
        Relationships: [];
      };
      audit_events: {
        Row: AuditEventRow;
        Insert: Insert<AuditEventRow, "org_id" | "actor_type" | "actor_label" | "action">;
        Update: Partial<AuditEventRow>;
        Relationships: [];
      };
      org_usage_alerts: {
        Row: OrgUsageAlertRow;
        Insert: Insert<OrgUsageAlertRow, "org_id" | "period_start" | "threshold">;
        Update: Partial<OrgUsageAlertRow>;
        Relationships: [];
      };
      organization_settings: {
        Row: OrganizationSettingsRow;
        Insert: Insert<OrganizationSettingsRow, "org_id">;
        Update: Partial<OrganizationSettingsRow>;
        Relationships: [];
      };
      org_secret_integrations: {
        Row: OrgSecretIntegrationRow;
        Insert: Insert<OrgSecretIntegrationRow, "org_id" | "provider" | "credentials_ciphertext" | "label">;
        Update: Partial<OrgSecretIntegrationRow>;
        Relationships: [];
      };
      environment_secret_links: {
        Row: EnvironmentSecretLinkRow;
        Insert: Insert<EnvironmentSecretLinkRow, "environment_id" | "integration_id" | "org_id" | "provider">;
        Update: Partial<EnvironmentSecretLinkRow>;
        Relationships: [];
      };
      org_provider_keys: {
        Row: OrgProviderKeyRow;
        Insert: Insert<OrgProviderKeyRow, "org_id" | "provider" | "key_ciphertext">;
        Update: Partial<OrgProviderKeyRow>;
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
        Insert: Insert<BillingCustomerRow, "org_id" | "stripe_customer_id">;
        Update: Partial<BillingCustomerRow>;
        Relationships: [];
      };
      subscriptions: {
        Row: SubscriptionRow;
        Insert: Insert<
          SubscriptionRow,
          | "stripe_subscription_id"
          | "org_id"
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
      composer_prompt_history: {
        Row: ComposerPromptHistoryRow;
        Insert: Insert<ComposerPromptHistoryRow, "owner_id" | "text">;
        Update: Partial<ComposerPromptHistoryRow>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      // supabase/migrations/20261102200000_missions.sql
      claim_mission_delivery: {
        Args: { target: string; lease_seconds: number; settle_seconds: number; max_wait_seconds: number };
        Returns: { delivery_id: string; attempt: number }[];
      };
      complete_mission_delivery: {
        Args: { target: string };
        Returns: undefined;
      };
      fail_mission_delivery: {
        Args: { target: string; failure: string };
        Returns: undefined;
      };
      // supabase/migrations/20261102260000_mission_profiles.sql
      latest_mission_events: {
        Args: { runner_ids: string[] };
        Returns: { runner_id: string; kind: string; payload: Json; created_at: string }[];
      };
      missions_with_pending_events: {
        Args: { max_missions: number };
        Returns: { mission_id: string }[];
      };
      // supabase/migrations/20261027120000_organizations.sql
      is_org_member: {
        Args: { org: string };
        Returns: boolean;
      };
      // supabase/migrations/20261028120000_team_orgs.sql
      my_org_ids: {
        Args: Record<never, never>;
        Returns: string[];
      };
      create_team_org: {
        Args: { org_name: string; creator: string; claimed_domain: string | null };
        Returns: string;
      };
      // supabase/migrations/20261102120000_api_keys.sql
      // supabase/migrations/20261103170000_media.sql
      reserve_media_upload: {
        Args: {
          media_id: string;
          media_public_id: string;
          media_org_id: string;
          media_owner_id: string;
          media_workspace_id: string | null;
          media_name: string;
          media_content_type: string;
          media_size_bytes: number;
          media_access: "public" | "private";
          media_storage_path: string;
          max_per_day: number;
          max_bytes: number;
        };
        /** Why not ('daily', 'storage'), or null when reserved. */
        Returns: string | null;
      };
      api_key_call_counts: {
        Args: { key_ids: string[]; since: string };
        Returns: { key_id: string; calls: number }[];
      };
      // supabase/migrations/20261028145000_org_access.sql
      project_level: {
        Args: { member: string; target_project: string };
        Returns: AccessLevelDb | null;
      };
      // supabase/migrations/20261102100000_github_agent_loop.sql
      github_member: {
        Args: { github_user_id: number; target_org: string };
        Returns: string | null;
      };
      // supabase/migrations/20261102110000_github_followups.sql
      queue_github_followup: {
        Args: {
          followup_kind: "ci" | "review";
          target_installation: number;
          target_project: string;
          target_repo: string;
          target_pr: number;
          commit_sha: string;
          review_id: number;
          delay_seconds: number;
        };
        Returns: { followup_id: string; fresh: boolean }[];
      };
      claim_github_followup: {
        Args: { target: string; max_turns: number };
        Returns: { outcome: "send" | "capped" | "quiet"; turns: number }[];
      };
      reset_github_ci_turns: {
        Args: { target_workspace: string };
        Returns: undefined;
      };
      // supabase/migrations/20261030120000_work_items.sql
      triage_project_levels: {
        Args: { member: string; target_org: string };
        Returns: { project_id: string; level: AccessLevelDb }[];
      };
      org_projects_level: {
        Args: { member: string; target_org: string };
        Returns: AccessLevelDb | null;
      };
      environment_level: {
        Args: { member: string; target_environment: string };
        Returns: AccessLevelDb | null;
      };
      // supabase/migrations/20261028155000_org_access_atomic.sql
      set_grant: {
        Args: { target_org: string; target_role: string | null; target_project: string | null; new_level: AccessLevelDb | null };
        Returns: undefined;
      };
      set_member_roles: {
        Args: { target_org: string; member: string; role_ids: string[] };
        Returns: undefined;
      };
      make_default_environment: {
        Args: { target_project: string; maker: string; checkout: string };
        Returns: string;
      };
      // supabase/migrations/20261030130000_automations.sql, and its
      // `settings` from 20261102190000_automation_schedules.sql.
      create_automation: {
        Args: {
          target_org: string;
          runner: string;
          automation_name: string;
          automation_template: string | null;
          automation_prompt: string;
          automation_triggers: AutomationTriggerDb[];
          is_enabled: boolean;
          project_ids: string[];
          settings: Json;
        };
        Returns: string;
      };
      update_automation: {
        Args: {
          target_org: string;
          automation: string;
          editor: string;
          automation_name: string | null;
          automation_prompt: string | null;
          automation_triggers: AutomationTriggerDb[] | null;
          is_enabled: boolean | null;
          project_ids: string[] | null;
          settings: Json;
        };
        Returns: boolean;
      };
      // supabase/migrations/20261102198000_automation_limits.sql
      automation_times_run: {
        Args: { automation: string };
        Returns: number;
      };
      record_automation_runs: {
        Args: { runs: Json };
        Returns: { run_id: string; run_automation_id: string; run_project_id: string; queued: boolean }[];
      };
      // supabase/migrations/20261028130000_org_members.sql
      accept_org_invite: {
        Args: { invite_token_hash: string; member: string };
        Returns: string;
      };
      approve_join_request: {
        Args: { request: string; decider: string; member_role: OrgRoleDb };
        Returns: string;
      };
      remove_org_member: {
        Args: { target_org: string; member: string; remover: string };
        Returns: undefined;
      };
      set_org_member_role: {
        Args: { target_org: string; member: string; member_role: OrgRoleDb };
        Returns: undefined;
      };
      // supabase/migrations/20261019130000_move_claude_slot_key.sql
      move_claude_slot_key: {
        Args: { mover: string; sealed: string; hint: string };
        Returns: boolean;
      };
      claim_billing_lease: {
        Args: { lease_name: string; seconds: number };
        Returns: boolean;
      };
      record_warm_run: {
        Args: { target: string; member: string; run: Json };
        Returns: undefined;
      };
      bump_environment_generation: {
        Args: { target: string };
        Returns: number;
      };
      claim_pooled_computer: {
        Args: { requested_workspace_id: string; requested_provider: string; requested_generation?: number | null };
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
      work_item_status: WorkItemStatusDb;
      work_item_source: WorkItemSourceDb;
    };
    CompositeTypes: Record<never, never>;
  };
};
