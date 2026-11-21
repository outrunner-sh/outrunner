-- The desktop browser's sign-ins, carried from one of a person's sessions to
-- their next in the same project. Every new session gets a box of its own, so
-- without them its browser starts signed out of everything, and the person
-- signs in to their app again in every session. The box's agent sends them as
-- they change and asks for them back for a new box's browser
-- (app/api/runtime/browser-sign-ins, runtime-agent/internal/desktop/sign_ins.go).
--
-- browser_sign_ins: one row per person and project, the session's owner and
-- project, never another's. The browser's cookies and localStorage as
-- Playwright's storageState, AES-256-GCM sealed (lib/crypto/secret-box.ts),
-- with the person and project inside the seal, so a row moved to another
-- person or project doesn't open (lib/browser-sign-ins/sign-ins.ts). Kept
-- until expires_at, which each save or use pushes out; deleted after it, with
-- the person, or with the project. Live sign-ins, so the same treatment as
-- claude_accounts: RLS on with no policy and every grant revoked, reached only
-- by the service role.
--
-- browser_sign_in_preferences: whether a person's are kept at all (Settings →
-- Sandbox). No row is kept; turning it off deletes every one they have.
-- ---------------------------------------------------------------------------

create table if not exists browser_sign_ins (
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  -- The storageState, sealed with the owner and project.
  state_ciphertext text not null,
  saved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (owner_id, project_id)
);

create index if not exists browser_sign_ins_expires_at on browser_sign_ins (expires_at);

alter table browser_sign_ins enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table browser_sign_ins from anon, authenticated;

create table if not exists browser_sign_in_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  keep boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table browser_sign_in_preferences enable row level security;
revoke all on table browser_sign_in_preferences from anon, authenticated;
