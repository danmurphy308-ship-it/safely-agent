-- Migration 008: record email verification results on leads.
-- Populated by the pipeline via Instantly's email-verification API before a
-- lead is scored (invalid addresses are deprioritised without spending a
-- Claude call, and sends are blocked on them). Values are Instantly's
-- verification statuses: verified, invalid, risky, catch_all, pending, or
-- 'unknown' when verification couldn't complete. Re-runnable.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS email_verification TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
