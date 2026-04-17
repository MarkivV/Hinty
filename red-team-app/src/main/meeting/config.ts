/**
 * config.ts — Meeting Copilot configuration.
 *
 * In production, the Deepgram API key will be fetched from the backend
 * (gated by Max tier). For development, reads from .env file.
 */

import * as fs from 'fs';
import * as path from 'path';

let cachedEnv: Record<string, string> | null = null;

function loadEnv(): Record<string, string> {
  if (cachedEnv) return cachedEnv;

  cachedEnv = {};
  try {
    const envPath = path.join(__dirname, '..', '..', '..', '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      cachedEnv[key] = value;
    }
  } catch {
    // .env not found — that's okay
  }
  return cachedEnv;
}

/**
 * Get the Deepgram API key.
 * TODO: In production, fetch from backend API (gated by Max tier).
 */
export function getDeepgramApiKey(): string {
  const env = loadEnv();
  return env['DEEPGRAM_API_KEY'] || process.env.DEEPGRAM_API_KEY || '';
}
