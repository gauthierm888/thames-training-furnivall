-- Tideway Trainer: shared scores in Cloudflare D1.
-- Run once: Cloudflare dashboard > Storage & databases > D1 > tideway > Console > paste this file > Execute.
-- chaos = 10 x collisions + 8 x groundings + 6 x dodgy overtakes + 3 x Code penalties.

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  time_s REAL NOT NULL,
  dist_m INTEGER NOT NULL,
  ul INTEGER NOT NULL DEFAULT 0,
  pen INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  aground INTEGER NOT NULL DEFAULT 0,
  clean INTEGER NOT NULL DEFAULT 0,
  bad INTEGER NOT NULL DEFAULT 0,
  boat TEXT NOT NULL,
  chaos INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS scores_score_idx ON scores (score DESC);
CREATE INDEX IF NOT EXISTS scores_chaos_idx ON scores (chaos DESC);
