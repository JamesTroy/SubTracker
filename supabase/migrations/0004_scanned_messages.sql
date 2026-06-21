-- ============================================================================
-- 0004 — true scan idempotency
-- Idempotency was keyed on charge_evidence, but rejected/dropped emails never get
-- an evidence row, so every scan re-fetched + re-extracted them (wasted Anthropic
-- spend + slow re-scans). Remember EVERY processed message id here instead.
-- ============================================================================

create table if not exists scanned_messages (
  gmail_message_id text primary key,
  scanned_at       timestamptz not null default now()
);

-- Backfill from what we already persisted so those aren't re-extracted. (The
-- dropped/rejected ids weren't stored anywhere, so they get re-processed once
-- more on the next scan, which then records them — and never again.)
insert into scanned_messages (gmail_message_id)
  select gmail_message_id from charge_evidence
  union
  select gmail_message_id from review_items
on conflict (gmail_message_id) do nothing;
