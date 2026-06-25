-- ============================================================================
-- 0005 — strict mode (precision-first ledger)
--   * app_settings: a tiny key/value store for app-wide toggles (strict_mode).
--   * subscriptions.status gains 'pending' — a confirmable service that has NOT
--     been explicitly approved by the user. In strict mode nothing reaches
--     'active' without a 'subscription' override (one-tap Approve), so the active
--     ledger is 100% human-approved by construction.
-- Additive + idempotent.
-- ============================================================================

create table if not exists app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
insert into app_settings (key, value) values ('strict_mode', 'false')
  on conflict (key) do nothing;

-- Allow the 'pending' status. (Drop + re-add the named check so this is re-runnable.)
alter table subscriptions drop constraint if exists status_chk;
alter table subscriptions add constraint status_chk check (status in
  ('active', 'past_due', 'ending', 'dormant', 'candidate', 'pending'));
