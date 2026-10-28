-- Orgs, step seven: who a user's sessions clone, push and open pull requests
-- as (Settings → General → GitHub identity). 'personal' is their own GitHub
-- sign-in, as every session has been until now; 'app' is the Outrunner
-- GitHub App installed on the repository's account in the session's org
-- (20261029100000_github_installations.sql), with short-lived tokens the box
-- asks for as it needs them (app/api/runtime/git-credential).
--
-- Everyone starts on 'personal', so nothing changes until they choose.
-- ---------------------------------------------------------------------------

alter table user_credentials
  add column if not exists github_identity text not null default 'personal';

alter table user_credentials
  drop constraint if exists user_credentials_github_identity_check;
alter table user_credentials
  add constraint user_credentials_github_identity_check
  check (github_identity in ('personal', 'app'));
