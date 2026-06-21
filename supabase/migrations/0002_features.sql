-- ============================================================================
-- 0002 — feature additions
--   * price-change tracking on subscriptions (prior price + when it moved)
-- Additive and idempotent: safe to run whether or not 0001 has been applied,
-- and safe to re-run.
-- ============================================================================

alter table subscriptions
  add column if not exists previous_amount_cents integer,   -- prior distinct price, in cents
  add column if not exists price_changed_at       timestamptz; -- when the price moved to amount_cents
