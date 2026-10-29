-- Previews (lib/previews): a link on Outrunner's preview domain to a server
-- running on a session's box, `https://<slug>.<RUNTIME_PREVIEW_DOMAIN>`, that
-- signs the visitor in and passes the request on to the box (server.ts,
-- lib/previews/proxy.ts).
--
-- `mode` says who gets through: `login`, any signed-in member of the
-- session's org who can read its repository; `public`, anyone with the link.
-- The slug is the link, random and never reused: deleting the row is what
-- revokes it, for every visitor at once (the proxy asks again every few
-- seconds), and a new preview of the same port is a new link.
--
-- The server's alone (RLS on, no policy, grants revoked), reached through
-- lib/db/previews.ts with the service role: who may see or change one is
-- decided there, from the session and the org's Roles & access.
-- ---------------------------------------------------------------------------

create table if not exists workspace_previews (
  id uuid primary key default gen_random_uuid(),
  -- The link's host label: 20 of [a-z0-9], about 103 bits, so a public
  -- link can't be guessed.
  slug text not null unique check (slug ~ '^[a-z0-9]{20}$'),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  -- A server of the user's: never privileged. The agent's port and the
  -- provider's are refused before a row is written (lib/runtime/box-ports.ts)
  -- and again on every request.
  port integer not null check (port between 1024 and 65535),
  label text check (label is null or char_length(label) between 1 and 80),
  mode text not null default 'login' check (mode in ('login', 'public')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One link a port: making it again hands back the one there is.
  unique (workspace_id, port)
);

create index if not exists workspace_previews_org_idx on workspace_previews (org_id);

alter table workspace_previews enable row level security;
revoke all on table workspace_previews from anon, authenticated;
