-- A session's branch Outrunner made up from its first prompt, which its agent
-- may rename once, before anything is pushed (lib/session/rename-branch.ts).
-- False for a branch the user chose, one already renamed, and every session
-- from before.
alter table workspaces add column branch_renamable boolean not null default false;
