/**
 * meetingRepository.ts — local SQLite storage for meetings & transcripts.
 *
 * Mirrors the style of repository.ts (chat sessions). Storage is local-only
 * for now (no cloud sync) — can be added later the same way sessions do.
 */

import { getDb } from './connection';
import type { MeetingSummary, MeetingDocument, TranscriptEntry } from '../../shared/types';

export interface MeetingRow {
  id: string;
  user_id: string;
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration: number;
  title: string | null;
  context: string | null;
  overview: string | null;
  key_decisions: string | null;   // JSON string[]
  action_items: string | null;    // JSON MeetingActionItem[]
  follow_ups: string | null;      // JSON string[]
  documents: string | null;       // JSON { fileName, fileType }[]
}

export interface MeetingTranscriptRow {
  id: number;
  meeting_id: string;
  timestamp_sec: number;
  speaker: string;
  channel: number;
  text: string;
  seq: number;
}

// ── Create / Update ──

/**
 * Create a meeting row at recording start. Called with just the basics; the
 * summary + transcript get attached when the meeting ends.
 */
export function createMeeting(
  id: string,
  userId: string,
  context: string,
  documents: MeetingDocument[],
  sessionId: string | null = null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const docList = documents.map(d => ({ fileName: d.fileName, fileType: d.fileType }));

  db.prepare(`
    INSERT OR REPLACE INTO meetings
      (id, user_id, session_id, started_at, context, documents)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, sessionId, now, context || null, JSON.stringify(docList));
}

/**
 * Fetch all meetings tied to a chat session, ordered by when they started.
 * A single session can accumulate many meetings as the user records more.
 */
export function getMeetingsForSession(sessionId: string): MeetingRow[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM meetings
       WHERE session_id = ? AND ended_at IS NOT NULL
       ORDER BY started_at ASC`
  ).all(sessionId) as MeetingRow[];
}

/**
 * Finalize a meeting — sets ended_at, duration, title, and summary blobs.
 * Called after the final summary is generated.
 */
export function finalizeMeeting(
  id: string,
  duration: number,
  title: string,
  summary: MeetingSummary | null,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE meetings SET
      ended_at      = ?,
      duration      = ?,
      title         = ?,
      overview      = ?,
      key_decisions = ?,
      action_items  = ?,
      follow_ups    = ?
    WHERE id = ?
  `).run(
    now,
    duration,
    title,
    summary?.overview || null,
    summary ? JSON.stringify(summary.keyDecisions || []) : null,
    summary ? JSON.stringify(summary.actionItems || []) : null,
    summary ? JSON.stringify(summary.followUps || []) : null,
    id,
  );
}

/**
 * Batch insert transcript entries for a meeting.
 */
export function saveTranscriptEntries(
  meetingId: string,
  entries: TranscriptEntry[],
): void {
  if (entries.length === 0) return;
  const db = getDb();

  // Clear any existing entries (idempotent if we ever re-save)
  db.prepare('DELETE FROM meeting_transcripts WHERE meeting_id = ?').run(meetingId);

  const insert = db.prepare(
    'INSERT INTO meeting_transcripts (meeting_id, timestamp_sec, speaker, channel, text, seq) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const insertAll = db.transaction((rows: TranscriptEntry[]) => {
    rows.forEach((e, i) => {
      insert.run(meetingId, e.timestamp, e.speaker, e.channel, e.text, i);
    });
  });

  insertAll(entries);
}

export function updateMeetingTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(title, id);
}

// ── Queries ──

export function getRecentMeetings(userId: string, limit = 100): MeetingRow[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM meetings
       WHERE user_id = ? AND ended_at IS NOT NULL
       ORDER BY started_at DESC
       LIMIT ?`
  ).all(userId, limit) as MeetingRow[];
}

export function getMeetingById(id: string): MeetingRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined;
  return row || null;
}

export function getMeetingTranscript(meetingId: string): MeetingTranscriptRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM meeting_transcripts WHERE meeting_id = ? ORDER BY seq ASC'
  ).all(meetingId) as MeetingTranscriptRow[];
}

// ── Delete ──

export function deleteMeeting(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  // transcripts cascade via FK
}

/**
 * Remove meetings that were started but never finalized (app crashed /
 * unclean shutdown). Called at startup to keep the list tidy.
 */
export function pruneIncompleteMeetings(olderThanMinutes = 30): void {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  const result = db.prepare(
    `DELETE FROM meetings WHERE ended_at IS NULL AND started_at < ?`
  ).run(cutoff);
  if (result.changes > 0) {
    console.log(`[db] Pruned ${result.changes} incomplete meetings`);
  }
}
