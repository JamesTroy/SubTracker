-- ============================================================================
-- 0003 — scan pipeline hardening
--   * record how many emails failed extraction in a scan (observability)
--   * give subscriptions.first_seen a default so it's set on insert and never
--     reset on re-scan (the rollup upsert omits the column)
-- Additive + idempotent.
-- ============================================================================

alter table scan_runs
  add column if not exists n_failed integer not null default 0;

alter table subscriptions
  alter column first_seen set default now();
