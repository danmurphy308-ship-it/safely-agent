-- -- Migration 018: internal auth — users table, seeded with placeholder
-- accounts behind a locked (unknowable) password hash. Login for each stays
-- impossible until `npm run user:set-password <email> <password>` is run for
-- it. No roles, no self-registration, no reset flow. Re-runnable.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Migration 018: internal auth — users table, seeded with the 4 known
-- accounts behind a locked (unknowable) placeholder password hash. Login for
-- each stays impossible until `npm run user:set-password <email> <password>`
-- is run for it. No roles, no self-registration, no reset flow. Re-runnable.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO users (email, password_hash, name) VALUES
  ('user1@example.com', '$2b$10$locked.placeholder.hash.login.impossible.until.set.password.is.run', 'User One'),
  ('user2@example.com', '$2b$10$locked.placeholder.hash.login.impossible.until.set.password.is.run', 'User Two')
ON CONFLICT (email) DO NOTHING;
