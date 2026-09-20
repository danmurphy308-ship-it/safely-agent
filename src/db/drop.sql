-- ============================================
-- Safely AI SDR — Drop all tables & functions
-- Used by `npm run db:reset` before re-applying schema.sql
-- ============================================

DROP TABLE IF EXISTS
  sequences,
  events,
  emails,
  scores,
  leads,
  campaigns,
  knowledge_base,
  blacklist
CASCADE;

DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
