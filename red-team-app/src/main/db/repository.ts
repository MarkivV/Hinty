import { getDb } from './connection';
import * as cloud from './cloudApi';

export interface SessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  ai_model: string | null;
  message_count: number;
  title: string | null;
  cached_messages: number;
  meeting_id: string | null;
}

/**
 * A session row enriched with meeting metadata for the unified history list.
 * Chat-only sessions have all meet_* fields null. Sessions may have multiple
 * meetings — meeting_count reflects that; meet_total_duration is the sum.
 */
export interface UnifiedHistoryRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  title: string | null;
  message_count: number;
  meeting_id: string | null;         // most recent meeting (for backward compat)
  meet_title: string | null;
  meet_duration: number | null;      // total duration across meetings in the session
  meet_overview: string | null;
  meeting_count: number;             // how many meetings are attached to this row
  has_documents: number;             // 0 | 1
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content_text: string | null;
  screenshot: string | null;
  created_at: string;
  seq: number;
}

// ── Session CRUD ──

export function createSession(id: string, aiModel: string, userId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO sessions (id, user_id, ai_model, started_at, cached_messages) VALUES (?, ?, ?, ?, 1)'
  ).run(id, userId, aiModel, now);

  // Fire-and-forget to cloud
  cloud.createCloudSession(id, aiModel).catch(() => {});
}

/**
 * Idempotent — safe to call every time we're about to persist something for
 * the session. Only inserts if the row doesn't exist yet. Used for lazy
 * creation (we no longer create sessions eagerly when the user just opens
 * the panel, because empty sessions would pollute history).
 */
export function ensureSessionExists(id: string, aiModel: string, userId: string): boolean {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
  if (existing) return false;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO sessions (id, user_id, ai_model, started_at, cached_messages) VALUES (?, ?, ?, ?, 1)'
  ).run(id, userId, aiModel, now);
  cloud.createCloudSession(id, aiModel).catch(() => {});
  return true;
}

/**
 * Link a meeting to a session. Called when a meeting starts recording while
 * a chat session is active — so the history entry shows both together.
 */
export function linkMeetingToSession(sessionId: string, meetingId: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET meeting_id = ? WHERE id = ?').run(meetingId, sessionId);
}

/**
 * Delete a session row if it has no messages AND no meeting attached.
 * Returns true if deleted. Called at session-end to prune noise.
 */
export function deleteSessionIfEmpty(id: string): boolean {
  const db = getDb();
  const row = db.prepare(
    `SELECT
       meeting_id,
       (SELECT COUNT(*) FROM messages WHERE session_id = ?)        AS msg_count,
       (SELECT COUNT(*) FROM meetings WHERE session_id = ?)         AS meet_count,
       (SELECT COUNT(*) FROM session_documents WHERE session_id = ?) AS doc_count
     FROM sessions WHERE id = ?`
  ).get(id, id, id, id) as
    | { meeting_id: string | null; msg_count: number; meet_count: number; doc_count: number }
    | undefined;

  if (!row) return false;
  if (row.meeting_id) return false;
  if (row.msg_count > 0) return false;
  if (row.meet_count > 0) return false;
  if (row.doc_count > 0) return false;

  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  cloud.deleteCloudSession(id).catch(() => {});
  console.log(`[db] Pruned empty session ${id}`);
  return true;
}

export function endSession(id: string, messageCount: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE sessions SET ended_at = ?, message_count = ? WHERE id = ?'
  ).run(now, messageCount, id);

  // Fire-and-forget to cloud
  cloud.updateCloudSession(id, { endedAt: now, messageCount }).catch(() => {});
}

export function saveAllMessages(
  sessionId: string,
  messages: { role: string; text: string; screenshot?: string | null }[],
): void {
  if (messages.length === 0) return;

  const db = getDb();

  // Clear existing messages first (handles continued sessions without duplication)
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

  const insert = db.prepare(
    'INSERT INTO messages (session_id, role, content_text, screenshot, seq) VALUES (?, ?, ?, ?, ?)'
  );

  const insertAll = db.transaction((msgs: typeof messages) => {
    msgs.forEach((m, i) => {
      insert.run(sessionId, m.role, m.text, m.screenshot || null, i);
    });
  });

  insertAll(messages);

  // Fire-and-forget to cloud
  const cloudMsgs = messages.map((m, i) => ({
    role: m.role,
    contentText: m.text,
    screenshot: m.screenshot || null,
    seq: i,
  }));
  cloud.saveCloudMessages(sessionId, cloudMsgs).catch(() => {});
}

export function updateSessionTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);

  // Fire-and-forget to cloud
  cloud.updateCloudSession(id, { title }).catch(() => {});
}

export function reopenSession(id: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET ended_at = NULL WHERE id = ?').run(id);
  console.log(`[db] Session ${id} reopened`);
}

export function deleteSession(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

  // Fire-and-forget to cloud
  cloud.deleteCloudSession(id).catch(() => {});
}

// ── Queries ──

export function getRecentSessions(userId: string, limit = 50): SessionRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(userId, limit) as SessionRow[];
}

/**
 * Unified history: every session (with joined meeting metadata if linked)
 * PLUS orphan meetings (meetings not linked to any session — legacy rows
 * saved before the unified model). Orphan meetings are surfaced as pseudo-
 * session rows where id = meeting id and message_count = 0.
 */
export function getUnifiedHistory(userId: string, limit = 100): UnifiedHistoryRow[] {
  const db = getDb();

  // Chat sessions, aggregating ALL meetings linked to them via session_id.
  // Also falls back to sessions.meeting_id for legacy rows where the
  // meetings.session_id column wasn't populated at create time.
  const sessionRows = db.prepare(`
    SELECT
      s.id               AS id,
      s.user_id          AS user_id,
      s.started_at       AS started_at,
      s.ended_at         AS ended_at,
      s.title            AS title,
      s.message_count    AS message_count,
      s.meeting_id       AS meeting_id,
      (SELECT m.title    FROM meetings m
         WHERE m.session_id = s.id OR m.id = s.meeting_id
         ORDER BY m.started_at DESC LIMIT 1) AS meet_title,
      (SELECT COALESCE(SUM(m.duration), 0) FROM meetings m
         WHERE m.session_id = s.id
            OR (s.meeting_id IS NOT NULL AND m.id = s.meeting_id AND m.session_id IS NULL)
      ) AS meet_duration,
      (SELECT m.overview FROM meetings m
         WHERE m.session_id = s.id OR m.id = s.meeting_id
         ORDER BY m.started_at DESC LIMIT 1) AS meet_overview,
      (SELECT COUNT(*) FROM meetings m
         WHERE m.session_id = s.id
            OR (s.meeting_id IS NOT NULL AND m.id = s.meeting_id AND m.session_id IS NULL)
      ) AS meeting_count,
      (SELECT CASE WHEN EXISTS (SELECT 1 FROM session_documents WHERE session_id = s.id) THEN 1 ELSE 0 END) AS has_documents
    FROM sessions s
    WHERE s.user_id = ?
  `).all(userId) as UnifiedHistoryRow[];

  // Orphan meetings: meetings that have neither session_id nor a session
  // pointing at them. Legacy rows from before the unified model.
  const orphanRows = db.prepare(`
    SELECT
      m.id               AS id,
      m.user_id          AS user_id,
      m.started_at       AS started_at,
      m.ended_at         AS ended_at,
      m.title            AS title,
      0                  AS message_count,
      m.id               AS meeting_id,
      m.title            AS meet_title,
      m.duration         AS meet_duration,
      m.overview         AS meet_overview,
      1                  AS meeting_count,
      0                  AS has_documents
    FROM meetings m
    WHERE m.user_id = ?
      AND m.ended_at IS NOT NULL
      AND m.session_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM sessions WHERE meeting_id = m.id)
  `).all(userId) as UnifiedHistoryRow[];

  const all = [...sessionRows, ...orphanRows];
  all.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
  return all.slice(0, limit);
}

export interface SessionDocumentRow {
  id: string;
  session_id: string;
  file_name: string;
  file_type: string;
  extracted_text: string;
  uploaded_at: string;
  seq: number;
}

export function insertSessionDocument(
  id: string,
  sessionId: string,
  fileName: string,
  fileType: string,
  extractedText: string,
  seq: number,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_documents (id, session_id, file_name, file_type, extracted_text, seq)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, sessionId, fileName, fileType, extractedText, seq);
}

export function getSessionDocuments(sessionId: string): SessionDocumentRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM session_documents WHERE session_id = ? ORDER BY seq ASC'
  ).all(sessionId) as SessionDocumentRow[];
}

export function deleteSessionDocument(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM session_documents WHERE id = ?').run(id);
}

export async function getSessionMessages(sessionId: string): Promise<MessageRow[]> {
  const db = getDb();

  // Check if messages are cached locally
  const session = db.prepare('SELECT cached_messages FROM sessions WHERE id = ?').get(sessionId) as { cached_messages: number } | undefined;

  if (session && session.cached_messages === 1) {
    // Messages are cached, return from local DB
    return db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
    ).all(sessionId) as MessageRow[];
  }

  // Not cached — fetch from cloud and cache locally
  console.log(`[db] Fetching messages for session ${sessionId} from cloud...`);
  const cloudMessages = await cloud.fetchSessionMessages(sessionId);

  if (cloudMessages.length > 0) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO messages (session_id, role, content_text, screenshot, seq) VALUES (?, ?, ?, ?, ?)'
    );
    const insertAll = db.transaction((msgs: any[]) => {
      for (const m of msgs) {
        insert.run(sessionId, m.role, m.contentText || m.content_text, m.screenshot, m.seq);
      }
    });
    insertAll(cloudMessages);

    // Mark as cached
    db.prepare('UPDATE sessions SET cached_messages = 1 WHERE id = ?').run(sessionId);
  }

  return db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
  ).all(sessionId) as MessageRow[];
}

// ── Sync ──

export async function syncSessionList(userId: string): Promise<void> {
  console.log(`[db] Syncing session list from cloud for user ${userId}...`);

  // Always wipe first — ensures no stale data from other accounts
  const db = getDb();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM sessions').run();
  console.log('[db] Local cache cleared before sync');

  const cloudSessions = await cloud.fetchSessionList(200);

  if (cloudSessions.length === 0) {
    console.log('[db] No cloud sessions to sync');
    return;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, user_id, started_at, ended_at, ai_model, message_count, title, cached_messages)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `);

  const insertAll = db.transaction((sessions: any[]) => {
    for (const s of sessions) {
      insert.run(
        s.id,
        userId,
        s.startedAt || s.started_at,
        s.endedAt || s.ended_at || null,
        s.aiModel || s.ai_model || null,
        s.messageCount ?? s.message_count ?? 0,
        s.title || null,
      );
    }
  });

  insertAll(cloudSessions);
  console.log(`[db] Synced ${cloudSessions.length} sessions from cloud`);
}

// ── Cleanup ──

export function wipeLocalCache(): void {
  const db = getDb();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM sessions').run();
  console.log('[db] Local cache wiped');
}
