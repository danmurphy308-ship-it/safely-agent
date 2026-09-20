-- Migration 016: HeyGen personalized video state on leads (score >= 85 only).
-- 'pending' from the moment the video is requested; the hourly heygenPoller
-- job flips it to 'completed' (with heygen_video_url set) or 'failed'.
-- sendSequenceEmail holds Instantly enrollment while 'pending' and
-- heygen_requested_at is under the 15-minute timeout, then sends without the
-- video past it. Re-runnable.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS heygen_video_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS heygen_video_status TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS heygen_video_url TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS heygen_requested_at TIMESTAMPTZ;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_heygen_video_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_heygen_video_status_check
  CHECK (heygen_video_status IN ('pending', 'completed', 'failed'));
