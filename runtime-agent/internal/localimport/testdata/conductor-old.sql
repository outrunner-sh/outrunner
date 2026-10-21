-- conductor-current.sql as an older Conductor had it: no workspaces.workspace_path,
-- sessions.title or sessions.model. Read with those as empty.
CREATE TABLE repos (
id TEXT PRIMARY KEY,
remote_url TEXT,
name TEXT,
default_branch TEXT DEFAULT 'main',
root_path TEXT,
setup_script TEXT,
created_at TEXT NOT NULL DEFAULT (datetime('now')),
updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, storage_version INTEGER DEFAULT 1, archive_script TEXT, display_order INTEGER DEFAULT 0, run_script TEXT, run_script_mode TEXT DEFAULT 'concurrent', remote TEXT, custom_prompt_code_review TEXT, custom_prompt_create_pr TEXT, custom_prompt_rename_branch TEXT, conductor_config TEXT, custom_prompt_general TEXT, icon TEXT, hidden INTEGER DEFAULT 0, custom_prompt_fix_errors TEXT, custom_prompt_resolve_merge_conflicts TEXT, file_include_globs TEXT, spotlight_testing INTEGER DEFAULT 0)
;
CREATE TABLE workspaces (
local_id TEXT PRIMARY KEY,
repository_id TEXT,
DEPRECATED_city_name TEXT,
directory_name TEXT,
DEPRECATED_archived INTEGER DEFAULT 0,
active_session_id TEXT,
branch TEXT,
created_at TEXT NOT NULL DEFAULT (datetime('now')),
updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, unread INTEGER DEFAULT 0, placeholder_branch_name TEXT, state TEXT DEFAULT 'active', initialization_parent_branch TEXT, big_terminal_mode INTEGER DEFAULT 0, setup_log_path TEXT, initialization_log_path TEXT, initialization_files_copied INTEGER, pinned_at TEXT, linked_workspace_ids TEXT, notes TEXT, intended_target_branch TEXT, manual_status TEXT, derived_status TEXT DEFAULT 'in-progress', archive_commit TEXT, pr_title TEXT, pr_description TEXT, secondary_directory_name TEXT, linked_directory_paths TEXT, hosting_server_url TEXT, sandbox_provider TEXT, user_set_workspace_name INTEGER DEFAULT 0, user_set_branch_name INTEGER DEFAULT 0, workspace_name TEXT, permission_level TEXT, creator_user_id TEXT, remote_file_sync_enabled INTEGER DEFAULT 0, creator_client_id TEXT, organization_id TEXT, assignee_user_id TEXT, watcher_user_ids TEXT, workspace_template_id TEXT, is_computer_admin INTEGER NOT NULL DEFAULT 0, auto_forward_enabled INTEGER DEFAULT 1, restricted INTEGER, access_level TEXT, number INTEGER, port_forwarding_enabled INTEGER DEFAULT 0, id TEXT, description TEXT, revision INTEGER, last_activity_at TEXT)
;
CREATE TABLE "sessions" (
id TEXT PRIMARY KEY,
status TEXT DEFAULT 'idle',
claude_session_id TEXT,
unread_count INTEGER DEFAULT 0,
freshly_compacted INTEGER DEFAULT 0,
context_token_count INTEGER DEFAULT 0,
created_at TEXT NOT NULL DEFAULT (datetime('now')),
updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, is_compacting INTEGER DEFAULT 0, permission_mode TEXT DEFAULT 'default', DEPRECATED_thinking_level TEXT DEFAULT 'NONE', last_user_message_at TEXT, resume_session_at TEXT, workspace_id TEXT, is_hidden INTEGER DEFAULT 0, agent_type, context_used_percent FLOAT, DEPRECATED_thinking_enabled INTEGER DEFAULT 1, codex_thinking_level TEXT, fast_mode INTEGER DEFAULT 0, agent_personality TEXT, claude_effort_level TEXT, feed_offset INTEGER, queue_paused_at TEXT, remote_archived_at TEXT, acp_config TEXT)
;
