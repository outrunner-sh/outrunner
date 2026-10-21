-- When the user's GitHub account stopped seeing a connected repository
-- (removed from an organization, a collaborator no more, the repository
-- deleted), read from a complete listing (lib/github/reconcile.ts). Kept rather
-- than deleting the project, which its sessions still point at; cleared when
-- the repository is seen again.
alter table projects
  add column if not exists access_lost_at timestamptz;
