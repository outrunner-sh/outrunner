-- A session's branch its agent named (it was Outrunner's stand-in until
-- then), which it may name again until anything is pushed or a pull request
-- is opened (lib/session/rename-branch.ts). False for a stand-in still to be
-- named, a branch the user chose, one pushed, and every session from before.
alter table workspaces add column branch_named boolean not null default false;
