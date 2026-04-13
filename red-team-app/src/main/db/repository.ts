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
