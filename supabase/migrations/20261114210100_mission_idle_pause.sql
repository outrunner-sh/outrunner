-- Phase 3: a bound Mission no human has replied to for 14 days is offered a
-- pause (idle_warned_at), and paused 24 hours later if still no human
-- replies (idle_paused). Any human reply moves last_human_at and clears the
-- offer. docs/missions.md, "Idle pause".
alter table mission_channels add column if not exists last_human_at timestamptz not null default now();
alter table mission_channels add column if not exists idle_warned_at timestamptz;
alter table mission_channels add column if not exists idle_paused boolean not null default false;
