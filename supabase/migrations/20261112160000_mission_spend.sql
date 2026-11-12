-- What a Mission and its Ships have spent (docs/mission-spend.md): each model
-- call the family made, once, under a reference unique to that call; and the
-- policy reservations a later budget holds against it. Policy accounting
-- only: nothing here bills anyone, changes who pays, or touches a key's cap.
-- Additive: new tables and functions, nothing existing changes.
-- ---------------------------------------------------------------------------

-- One model call, attributed to the Mission whose family made it: the
-- Mission's own session, one of its Ships, or a classifier call made for it.
-- `usage_ref` is the call's own id (Claude's message id, Codex's record,
-- OpenRouter's generation), unique across every Mission, so a call read twice
-- (a re-read log, a restored box, a forked transcript) counts once, and to one
-- Mission only.
create table if not exists mission_usage (
  usage_ref text primary key check (char_length(usage_ref) between 1 and 300),
  mission_id uuid not null references workspaces (id) on delete cascade,
  -- The session whose call it was; null for a classifier call, or once the
  -- session is gone (its spend stays the Mission's).
  workspace_id uuid references workspaces (id) on delete set null,
  source text not null check (source in ('session', 'classifier')),
  -- When the call was made, as its log says: what puts it in a day or week.
  occurred_at timestamptz not null,
  model text check (char_length(model) <= 200),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_creation_input_tokens bigint not null default 0 check (cache_creation_input_tokens >= 0),
  cache_read_input_tokens bigint not null default 0 check (cache_read_input_tokens >= 0),
  -- How its cost is known:
  --   reported     the provider said what the call cost (usd_reported);
  --   estimated    tokens priced on a versioned cost basis (usd_estimated,
  --                cost_basis);
  --   unavailable  neither: unknown, never $0.
  coverage text not null check (coverage in ('reported', 'estimated', 'unavailable')),
  usd_reported numeric(16, 8) check (usd_reported >= 0),
  usd_estimated numeric(16, 8) check (usd_estimated >= 0),
  cost_basis text check (char_length(cost_basis) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mission_usage_cost_matches_coverage check (
    (coverage = 'reported' and usd_reported is not null)
    or (coverage = 'estimated' and usd_estimated is not null and cost_basis is not null)
    or (coverage = 'unavailable' and usd_reported is null and usd_estimated is null)
  )
);

create index if not exists mission_usage_mission_time_idx on mission_usage (mission_id, occurred_at);

-- Record calls (a JSON array of them), each once. A call seen again keeps its
-- Mission and session, and takes the newer reading only if it says more:
-- Claude logs each block of a reply with the reply's usage so far, so a later
-- record of the same call has as many tokens or more. A reported cost is never
-- replaced by an estimate or by nothing. Returns how many rows were new.
create or replace function record_mission_usage(calls jsonb)
  returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  call jsonb;
  made integer := 0;
  is_new boolean;
begin
  if jsonb_typeof(calls) <> 'array' then
    raise exception 'record_mission_usage takes a JSON array.' using errcode = '22023';
  end if;
  for call in select value from jsonb_array_elements(calls) loop
    if not exists (select 1 from workspaces w where w.id = (call->>'mission_id')::uuid and w.kind = 'mission') then
      raise exception 'Usage can only be attributed to a Mission.' using errcode = '23514';
    end if;
    insert into mission_usage as u (
      usage_ref, mission_id, workspace_id, source, occurred_at, model,
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
      coverage, usd_reported, usd_estimated, cost_basis
    ) values (
      call->>'usage_ref',
      (call->>'mission_id')::uuid,
      nullif(call->>'workspace_id', '')::uuid,
      call->>'source',
      (call->>'occurred_at')::timestamptz,
      call->>'model',
      coalesce((call->>'input_tokens')::bigint, 0),
      coalesce((call->>'output_tokens')::bigint, 0),
      coalesce((call->>'cache_creation_input_tokens')::bigint, 0),
      coalesce((call->>'cache_read_input_tokens')::bigint, 0),
      call->>'coverage',
      (call->>'usd_reported')::numeric,
      (call->>'usd_estimated')::numeric,
      call->>'cost_basis'
    )
    on conflict (usage_ref) do update set
      model = excluded.model,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_input_tokens = excluded.cache_creation_input_tokens,
      cache_read_input_tokens = excluded.cache_read_input_tokens,
      coverage = excluded.coverage,
      usd_reported = excluded.usd_reported,
      usd_estimated = excluded.usd_estimated,
      cost_basis = excluded.cost_basis,
      updated_at = now()
    where
      -- The same Mission's call only: another Mission's reading of it (a
      -- forked transcript) changes nothing.
      u.mission_id = excluded.mission_id
      and (u.coverage <> 'reported' or excluded.coverage = 'reported')
      and (excluded.input_tokens + excluded.output_tokens + excluded.cache_creation_input_tokens + excluded.cache_read_input_tokens)
        >= (u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens)
      and (
        excluded.input_tokens + excluded.output_tokens + excluded.cache_creation_input_tokens + excluded.cache_read_input_tokens
          > u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
        or (excluded.coverage = 'reported' and u.coverage <> 'reported')
        or (excluded.coverage = 'estimated' and u.coverage = 'unavailable')
      )
    returning (xmax = 0) into is_new;
    if is_new then
      made := made + 1;
    end if;
  end loop;
  return made;
end;
$$;

-- A Mission family's model spend between two instants, by coverage: what was
-- reported, what was estimated (and on which bases), and how many calls'
-- cost is unknown.
create or replace function mission_usage_totals(target uuid, from_at timestamptz, to_at timestamptz)
  returns table (
    reported_usd numeric,
    reported_calls bigint,
    estimated_usd numeric,
    estimated_calls bigint,
    unavailable_calls bigint,
    cost_bases text[],
    input_tokens bigint,
    output_tokens bigint,
    cache_creation_input_tokens bigint,
    cache_read_input_tokens bigint
  )
  language sql
  stable
  security definer
  set search_path = public
as $$
  select
    coalesce(sum(u.usd_reported) filter (where u.coverage = 'reported'), 0),
    count(*) filter (where u.coverage = 'reported'),
    coalesce(sum(u.usd_estimated) filter (where u.coverage = 'estimated'), 0),
    count(*) filter (where u.coverage = 'estimated'),
    count(*) filter (where u.coverage = 'unavailable'),
    coalesce(array_agg(distinct u.cost_basis) filter (where u.coverage = 'estimated'), '{}'),
    coalesce(sum(u.input_tokens), 0)::bigint,
    coalesce(sum(u.output_tokens), 0)::bigint,
    coalesce(sum(u.cache_creation_input_tokens), 0)::bigint,
    coalesce(sum(u.cache_read_input_tokens), 0)::bigint
  from mission_usage u
  where u.mission_id = target and u.occurred_at >= from_at and u.occurred_at < to_at;
$$;

-- Policy reservations: an amount a caller holds against a Mission's spend
-- before work whose cost isn't known yet, then settles once it is. One per
-- (Mission, operation id), so a retried reserve, renew or settle is the same
-- one. A hold is never dropped by time: one that expires unsettled, or is
-- settled without a known cost, stays as uncertain liability until settled
-- with a cost. Policy only: no invoice, no payer, no key.
create table if not exists mission_spend_reservations (
  mission_id uuid not null references workspaces (id) on delete cascade,
  operation_id text not null check (char_length(operation_id) between 1 and 200),
  -- held       live, until expires_at;
  -- uncertain  expired unsettled, or settled with no known cost: still owed;
  -- settled    its cost is known (settled_usd), and is in mission_usage.
  state text not null default 'held' check (state in ('held', 'uncertain', 'settled')),
  amount_usd numeric(16, 8) not null check (amount_usd >= 0),
  settled_usd numeric(16, 8) check (settled_usd >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (mission_id, operation_id),
  constraint mission_spend_reservations_settled check ((state = 'settled') = (settled_usd is not null))
);

create index if not exists mission_spend_reservations_open_idx
  on mission_spend_reservations (mission_id) where state <> 'settled';

-- The Mission's lock: its row, as the Ships' cap takes it. Every reservation
-- change is made under it, so racing callers see each other's holds.
create or replace function lock_mission_for_spend(target uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  perform 1 from workspaces w where w.id = target and w.kind = 'mission' for update;
  if not found then
    raise exception 'mission_not_found: no Mission %', target using errcode = 'P0002';
  end if;
  -- Expired holds become uncertain, never dropped.
  update mission_spend_reservations r
    set state = 'uncertain', updated_at = now()
    where r.mission_id = target and r.state = 'held' and r.expires_at <= now();
end;
$$;

-- What the Mission holds after a change: live holds and uncertain liability.
create or replace function mission_spend_liability(target uuid)
  returns table (held_usd numeric, uncertain_usd numeric, open_reservations bigint)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select
    coalesce(sum(r.amount_usd) filter (where r.state = 'held' and r.expires_at > now()), 0),
    coalesce(sum(r.amount_usd) filter (where r.state = 'uncertain' or (r.state = 'held' and r.expires_at <= now())), 0),
    count(*) filter (where r.state <> 'settled')
  from mission_spend_reservations r
  where r.mission_id = target;
$$;

-- Reserve `amount` for `operation`, held for `hold_seconds`. Idempotent: the
-- operation's reservation as it stands if it's made already (replayed true),
-- whatever this call asked.
create or replace function reserve_mission_spend(target uuid, operation text, amount numeric, hold_seconds integer)
  returns table (state text, amount_usd numeric, settled_usd numeric, expires_at timestamptz, replayed boolean,
                 held_usd numeric, uncertain_usd numeric)
  language plpgsql
  security definer
  set search_path = public
as $$
#variable_conflict use_column
declare
  made boolean := false;
begin
  if amount is null or amount < 0 then
    raise exception 'A reservation is a non-negative amount.' using errcode = '22023';
  end if;
  if hold_seconds is null or hold_seconds <= 0 then
    raise exception 'A reservation is held for a positive time.' using errcode = '22023';
  end if;
  perform lock_mission_for_spend(target);
  insert into mission_spend_reservations (mission_id, operation_id, amount_usd, expires_at)
    values (target, operation, amount, now() + make_interval(secs => hold_seconds))
    on conflict (mission_id, operation_id) do nothing;
  get diagnostics made = row_count;
  return query
    select r.state, r.amount_usd, r.settled_usd, r.expires_at, not made, l.held_usd, l.uncertain_usd
    from mission_spend_reservations r, mission_spend_liability(target) l
    where r.mission_id = target and r.operation_id = operation;
end;
$$;

-- Hold `operation` longer, and at least `amount` (null: as it is). Never
-- lowers a hold or shortens it, so a renewal retried or overtaken is
-- harmless. A hold that lapsed into uncertain is held again; a settled one
-- is left as it is.
create or replace function renew_mission_spend(target uuid, operation text, amount numeric, hold_seconds integer)
  returns table (state text, amount_usd numeric, settled_usd numeric, expires_at timestamptz, replayed boolean,
                 held_usd numeric, uncertain_usd numeric)
  language plpgsql
  security definer
  set search_path = public
as $$
#variable_conflict use_column
begin
  if amount is not null and amount < 0 then
    raise exception 'A reservation is a non-negative amount.' using errcode = '22023';
  end if;
  if hold_seconds is null or hold_seconds <= 0 then
    raise exception 'A reservation is held for a positive time.' using errcode = '22023';
  end if;
  perform lock_mission_for_spend(target);
  update mission_spend_reservations r
    set state = 'held',
        amount_usd = greatest(r.amount_usd, coalesce(amount, r.amount_usd)),
        expires_at = greatest(r.expires_at, now() + make_interval(secs => hold_seconds)),
        updated_at = now()
    where r.mission_id = target and r.operation_id = operation and r.state <> 'settled';
  if not exists (select 1 from mission_spend_reservations r where r.mission_id = target and r.operation_id = operation) then
    raise exception 'reservation_not_found: no reservation % on Mission %', operation, target using errcode = 'P0002';
  end if;
  return query
    select r.state, r.amount_usd, r.settled_usd, r.expires_at, r.state = 'settled', l.held_usd, l.uncertain_usd
    from mission_spend_reservations r, mission_spend_liability(target) l
    where r.mission_id = target and r.operation_id = operation;
end;
$$;

-- Settle `operation`: with its cost known (`actual`), the hold is released
-- (the cost itself is the usage recorded for the call); with it unknown
-- (null), the hold stays as uncertain liability, to be settled again once it
-- is known. Settled once with a cost, it stays so: a repeat is replayed.
create or replace function settle_mission_spend(target uuid, operation text, actual numeric)
  returns table (state text, amount_usd numeric, settled_usd numeric, expires_at timestamptz, replayed boolean,
                 held_usd numeric, uncertain_usd numeric)
  language plpgsql
  security definer
  set search_path = public
as $$
#variable_conflict use_column
declare
  existing mission_spend_reservations%rowtype;
begin
  if actual is not null and actual < 0 then
    raise exception 'A cost is a non-negative amount.' using errcode = '22023';
  end if;
  perform lock_mission_for_spend(target);
  select * into existing from mission_spend_reservations r where r.mission_id = target and r.operation_id = operation;
  if not found then
    raise exception 'reservation_not_found: no reservation % on Mission %', operation, target using errcode = 'P0002';
  end if;
  if existing.state <> 'settled' then
    update mission_spend_reservations r
      set state = case when actual is null then 'uncertain' else 'settled' end,
          settled_usd = actual,
          settled_at = case when actual is null then null else now() end,
          updated_at = now()
      where r.mission_id = target and r.operation_id = operation;
  end if;
  return query
    select r.state, r.amount_usd, r.settled_usd, r.expires_at, existing.state = 'settled', l.held_usd, l.uncertain_usd
    from mission_spend_reservations r, mission_spend_liability(target) l
    where r.mission_id = target and r.operation_id = operation;
end;
$$;

alter table mission_usage enable row level security;
alter table mission_spend_reservations enable row level security;
-- No policy, on purpose (as the other Missions tables): the server reads and
-- writes these with the service role, after checking who may.
revoke all on table mission_usage from anon, authenticated;
revoke all on table mission_spend_reservations from anon, authenticated;
revoke all on function record_mission_usage(jsonb) from public, anon, authenticated;
revoke all on function mission_usage_totals(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function lock_mission_for_spend(uuid) from public, anon, authenticated;
revoke all on function mission_spend_liability(uuid) from public, anon, authenticated;
revoke all on function reserve_mission_spend(uuid, text, numeric, integer) from public, anon, authenticated;
revoke all on function renew_mission_spend(uuid, text, numeric, integer) from public, anon, authenticated;
revoke all on function settle_mission_spend(uuid, text, numeric) from public, anon, authenticated;
