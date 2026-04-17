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

  // ── Meetings ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at        TEXT,
      duration        INTEGER DEFAULT 0,
      title           TEXT,
      context         TEXT,
      overview        TEXT,
      key_decisions   TEXT,
      action_items    TEXT,
      follow_ups      TEXT,
      documents       TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_transcripts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      timestamp_sec REAL NOT NULL,
      speaker       TEXT NOT NULL,
      channel       INTEGER NOT NULL,
      text          TEXT NOT NULL,
      seq           INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_meeting ON meeting_transcripts(meeting_id)
  `);

  // ── Session documents (shared between chat + meeting) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_documents (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      file_name     TEXT NOT NULL,
      file_type     TEXT NOT NULL,
      extracted_text TEXT NOT NULL,
      uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
      seq           INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_docs_session ON session_documents(session_id)
  `);

  // ── Migrations (run after CREATE TABLE IF NOT EXISTS so fresh DBs no-op) ──
  runMigrations(db);

  console.log('[db] SQLite schema initialized');
}

/**
 * Idempotent column additions for existing DBs. `ALTER TABLE ADD COLUMN`
 * fails if the column already exists, so each is wrapped in a try/catch.
 */
function runMigrations(db: ReturnType<typeof getDb>): void {
  const safeAlter = (sql: string, label: string) => {
    try {
      db.exec(sql);
      console.log(`[db migration] ${label}: applied`);
    } catch (err: any) {
      if (!/duplicate column/i.test(err.message || '')) {
        console.error(`[db migration] ${label} failed:`, err.message);
      }
    }
  };

  // Link a chat session to a meeting (nullable — chat-only sessions leave it null).
  // NOTE: this column is legacy. It holds the MOST RECENT meeting for a session
  // as a convenience, but the canonical relationship lives on meetings.session_id
  // so one session can have many meetings without overwriting.
  safeAlter('ALTER TABLE sessions ADD COLUMN meeting_id TEXT', 'sessions.meeting_id');
  safeAlter('CREATE INDEX IF NOT EXISTS idx_sessions_meeting ON sessions(meeting_id)', 'idx_sessions_meeting');

  // Canonical session→meeting FK: every meeting created during a session
  // carries the session id. Multiple meetings per session are supported.
  // Legacy meetings (created before this column existed) will have NULL and
  // surface as "orphan" history rows.
  safeAlter('ALTER TABLE meetings ADD COLUMN session_id TEXT', 'meetings.session_id');
  safeAlter('CREATE INDEX IF NOT EXISTS idx_meetings_session ON meetings(session_id)', 'idx_meetings_session');
}
