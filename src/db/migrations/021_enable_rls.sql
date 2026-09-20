-- 021: Enable Row-Level Security on every public table (Supabase Security
-- Advisor: rls_disabled_in_public). RLS was off on all 12 tables, and
-- Supabase's default anon/authenticated roles both held full SELECT/INSERT/
-- UPDATE/DELETE/TRUNCATE grants on every one of them (including `users`,
-- which holds bcrypt password hashes) — anyone with this project's anon key
-- could read/write/delete/truncate any table via Supabase's public REST API,
-- completely bypassing this app's own session auth.
--
-- Safe for this app specifically: the backend connects via DATABASE_URL as
-- the `postgres` role, which has rolbypassrls = true (verified live against
-- both the local and the Fly-deployed connection, 2026-07-27) — it
-- structurally bypasses RLS regardless of what policies exist. No policies
-- are written here on purpose: this app has no legitimate anon/authenticated
-- use case (no Supabase Auth, no client-side Supabase calls anywhere in this
-- codebase — the React client only ever talks to this app's own /api/*
-- routes). "RLS enabled, zero policies" means default-deny for every
-- non-bypassing role, which is exactly the desired outcome, and revoking the
-- standing anon/authenticated grants below removes the exposure a second way
-- even if RLS were ever mistakenly disabled on a table later.

ALTER TABLE blacklist      ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails         ENABLE ROW LEVEL SECURITY;
ALTER TABLE events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_assists  ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequences      ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON blacklist      FROM anon, authenticated;
REVOKE ALL ON campaigns      FROM anon, authenticated;
REVOKE ALL ON emails         FROM anon, authenticated;
REVOKE ALL ON events         FROM anon, authenticated;
REVOKE ALL ON knowledge_base FROM anon, authenticated;
REVOKE ALL ON leads          FROM anon, authenticated;
REVOKE ALL ON process_runs   FROM anon, authenticated;
REVOKE ALL ON reply_assists  FROM anon, authenticated;
REVOKE ALL ON scores         FROM anon, authenticated;
REVOKE ALL ON sequences      FROM anon, authenticated;
REVOKE ALL ON settings       FROM anon, authenticated;
REVOKE ALL ON users          FROM anon, authenticated;
