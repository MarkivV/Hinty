import Database from 'better-sqlite3';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(app.getPath('userData'), 'hinty-cache.sqlite3');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('[db] SQLite opened at', dbPath);
  }
  return db;
}

export function closeConnection(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[db] SQLite closed');
  }
}

export function deleteDatabase(): void {
  closeConnection();
  const dbPath = path.join(app.getPath('userData'), 'hinty-cache.sqlite3');
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    console.log('[db] Database file deleted');
  } catch (err) {
    console.warn('[db] Failed to delete database file:', err);
  }
}
