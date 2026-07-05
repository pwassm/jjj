-- SLAM API D1 schema. Apply with:
--   npx wrangler d1 execute sal-db --file=schema.sql --remote
-- All timestamps are Unix epoch MILLISECONDS (Date.now()).

CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,
  name       TEXT,                            -- optional display name
  role       TEXT NOT NULL DEFAULT 'user',    -- user | expert | admin
  created    INTEGER NOT NULL,
  last_login INTEGER
);

-- One-time magic-link tokens (15 min lifetime, single use).
CREATE TABLE IF NOT EXISTS login_tokens (
  token   TEXT PRIMARY KEY,
  email   TEXT NOT NULL,
  site    TEXT,                               -- origin to redirect back to
  ip      TEXT,
  created INTEGER NOT NULL,
  used    INTEGER NOT NULL DEFAULT 0
);

-- Bearer sessions issued by /auth/verify (30 days).
CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  email   TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);

-- Expert comments, keyed to ml.json row UID.
CREATE TABLE IF NOT EXISTS comments (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  uid     TEXT NOT NULL,
  email   TEXT NOT NULL,
  body    TEXT NOT NULL,
  created INTEGER NOT NULL,
  status  TEXT NOT NULL DEFAULT 'approved'    -- approved | hidden
);
CREATE INDEX IF NOT EXISTS idx_comments_uid ON comments(uid, status);

-- Private messages to Phil from any logged-in user. kind 'report' is the
-- "I object to this link / please take it down" path, optionally row-keyed.
CREATE TABLE IF NOT EXISTS messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  uid     TEXT,                               -- optional ml.json row UID
  email   TEXT NOT NULL,
  kind    TEXT NOT NULL DEFAULT 'general',    -- general | report
  body    TEXT NOT NULL,
  created INTEGER NOT NULL,
  status  TEXT NOT NULL DEFAULT 'new'         -- new | read | done
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
