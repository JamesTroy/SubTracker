-- ============================================================================
-- Subscription tracker — initial schema
-- Money is stored as integer cents everywhere to avoid floating-point drift.
-- ============================================================================

-- Connected Gmail account(s). Refresh token is AES-256-GCM encrypted at rest;
-- the server never stores it in plaintext. Single-user today, but keyed for more.
create table if not exists gmail_accounts (
  id                      uuid primary key default gen_random_uuid(),
  email                   text not null unique,
  enc_refresh_token       text not null,   -- base64 ciphertext
  enc_iv                  text not null,   -- base64 iv
  enc_tag                 text not null,   -- base64 auth tag
  scopes                  text not null default 'gmail.readonly',
  last_scan_at            timestamptz,
  created_at              timestamptz not null default now()
);

-- Rolled-up subscriptions. One row per normalized service.
create table if not exists subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  service_key             text not null unique,         -- 'vons-freshpass', normalized
  service_name            text not null,                -- 'Vons FreshPass'
  service_domain          text,                         -- resolved from body, not sender
  amount_cents            integer,                      -- null = known sub, unknown price
  currency                text default 'USD',
  billing_cycle           text not null default 'unknown',
    constraint billing_cycle_chk check (billing_cycle in
      ('weekly','monthly','quarterly','annual','unknown')),
  status                  text not null default 'candidate',
    constraint status_chk check (status in
      ('active','past_due','ending','dormant','candidate')),
  next_renewal            date,
  category                text,
  cancel_url              text,
  confidence              real,
  evidence_count          integer not null default 0,   -- how many emails corroborate it
  first_seen              timestamptz,
  last_seen               timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Raw, per-email signals. Separated from the rollup so we can show payment
-- history, detect price changes, and re-derive subscriptions if guards improve.
create table if not exists charge_evidence (
  id                      uuid primary key default gen_random_uuid(),
  gmail_message_id        text not null unique,          -- idempotency key for scans
  subscription_id         uuid references subscriptions(id) on delete set null,
  service_key             text not null,
  from_name               text,
  from_domain             text,
  subject                 text,
  received_at             timestamptz not null,
  amount_cents            integer,                       -- grounded amount, or null
  currency                text,
  event_type              text not null default 'none',
    constraint event_type_chk check (event_type in
      ('charged','upcoming','payment_failed','cancelled','started','none')),
  amount_quote            text,                          -- the literal text the amount came from
  raw_confidence          real,
  created_at              timestamptz not null default now()
);

-- Anything the guards couldn't safely confirm. The user resolves these; the
-- resolution is remembered in service_overrides so it never has to be asked twice.
create table if not exists review_items (
  id                      uuid primary key default gen_random_uuid(),
  gmail_message_id        text not null unique,
  service_key             text,
  reason                  text not null,                 -- why it landed here
  raw                     jsonb,                         -- the full extraction for context
  status                  text not null default 'pending',
    constraint review_status_chk check (status in ('pending','confirmed','rejected')),
  resolved_service_key    text,
  created_at              timestamptz not null default now(),
  resolved_at             timestamptz
);

-- The learning loop. A user decision about a service is durable, so the same
-- ambiguous pattern auto-resolves on every future scan.
create table if not exists service_overrides (
  service_key             text primary key,
  decision                text not null,
    constraint decision_chk check (decision in ('subscription','not_subscription')),
  note                    text,
  created_at              timestamptz not null default now()
);

-- One row per scan, for history and the dashboard's "last scanned" line.
create table if not exists scan_runs (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid references gmail_accounts(id) on delete cascade,
  started_at              timestamptz not null default now(),
  finished_at             timestamptz,
  emails_scanned          integer not null default 0,
  emails_new              integer not null default 0,
  n_active                integer not null default 0,
  n_past_due              integer not null default 0,
  n_ending                integer not null default 0,
  n_review                integer not null default 0,
  n_rejected              integer not null default 0,
  error                   text
);

create index if not exists idx_evidence_service on charge_evidence(service_key);
create index if not exists idx_evidence_received on charge_evidence(received_at desc);
create index if not exists idx_subs_status on subscriptions(status);
create index if not exists idx_review_status on review_items(status);

-- Single-user app: access is via the service-role key from the server only.
-- If this ever goes multi-user, enable RLS here and scope every table by user_id.
