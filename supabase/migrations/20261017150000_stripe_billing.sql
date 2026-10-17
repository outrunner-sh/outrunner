-- Stripe billing: who each user is in Stripe, a copy of their subscriptions
-- (lib/billing/subscriptions.ts reads plans from it), and the webhook events
-- already handled. Stripe is the source of truth: every row here is rewritten
-- from what Stripe says, never edited by the app on its own.
--
-- Service-role only, like user_credentials: RLS on with no policies, so no
-- user can read another's billing, or give themselves a plan.
-- ---------------------------------------------------------------------------

-- A user's Stripe customer: made once, on their first checkout.
create table billing_customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

alter table billing_customers enable row level security;

-- A user's subscriptions as Stripe last reported them. Not one per user:
-- Stripe can hold two at once (checkout refuses a second, but one made in the
-- dashboard isn't stopped), and this copy must say what Stripe says. The plan
-- is the best one a user is entitled to.
create table subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  stripe_customer_id text not null,
  -- Stripe's status: active, trialing, past_due, unpaid, canceled, ...
  status text not null,
  plan text not null check (plan in ('pro', 'max', 'enterprise')),
  -- The price's lookup key (pro_monthly, ...); null for a custom price.
  price_lookup_key text,
  billing_interval text check (billing_interval in ('month', 'year')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  -- When it went past due, for the grace before the plan lapses; null
  -- otherwise.
  past_due_since timestamptz,
  updated_at timestamptz not null default now()
);

create index subscriptions_user_idx on subscriptions (user_id);

create trigger subscriptions_set_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

alter table subscriptions enable row level security;

-- Webhook events already handled, so a redelivery does nothing. Recorded
-- after an event is handled, not before, so a failure is retried.
create table stripe_events (
  id text primary key,
  type text not null,
  handled_at timestamptz not null default now()
);

alter table stripe_events enable row level security;
