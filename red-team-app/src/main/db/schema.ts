import { getDb } from './connection';

export function initDatabase(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at      TEXT,
      ai_model      TEXT,
      message_count INTEGER DEFAULT 0,
      title         TEXT,
      cached_messages INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role          TEXT NOT NULL,
      content_text  TEXT,
      screenshot    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      seq           INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)
  `);

  console.log('[db] SQLite schema initialized');
}
