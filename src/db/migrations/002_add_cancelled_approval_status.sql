-- Migration 002: add 'cancelled' to the emails approval_status CHECK constraint.
-- Sequence follow-ups (emails 2 and 3) are cancelled when the lead replies,
-- books, unsubscribes, or bounces before they have been sent.

ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_approval_status_check;

ALTER TABLE emails ADD CONSTRAINT emails_approval_status_check CHECK (approval_status IN (
  'pending', 'approved', 'rejected', 'cancelled'
));
