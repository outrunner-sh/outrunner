-- The model a session runs, and whose it is (lib/runtime/session-models.ts):
-- the provider ("outrunner", "claude", "codex", or a provider of the user's
-- own key), the model's id there, and the effort picked for it. Written when
-- the session starts on a model and each time it switches, so a session that
-- relaunches (a resume, an attach that starts it, a restore) goes back on the
-- model it was on, its key fetched again: a key replaced since is the one it
-- runs on, and one removed stops it.
--
-- Null for sessions from before this column, which relaunch as they did.
-- Never a key: those stay sealed in user_credentials / user_provider_keys.

alter table workspaces add column if not exists model_provider text;
alter table workspaces add column if not exists model_id text;
alter table workspaces add column if not exists model_effort text;

alter table workspaces drop constraint if exists workspaces_model_ck;
alter table workspaces add constraint workspaces_model_ck
  check (
    (model_provider is null) = (model_id is null)
    and (model_provider is null or model_provider ~ '^[a-z][a-z0-9-]{1,31}$')
    and (model_id is null or char_length(model_id) between 1 and 100)
    and (model_effort is null or model_effort in ('low', 'medium', 'high', 'xhigh', 'max'))
  );
