/**
 * meeting/index.ts — Meeting Copilot orchestrator.
 *
 * Manages the meeting lifecycle:
 *   prep → recording → ended
 *
 * Wires together:
 *   audioCapture → stt → transcript → aiEngine
 *
 * Sends updates to the sidepanel renderer via IPC.
 */

import { nanoid } from 'nanoid';
import { audioCapture, PermissionStatus } from './audioCapture';
import { SttClient, TranscriptEvent } from './stt';
import { TranscriptBuffer } from './transcript';
import { getDeepgramApiKey } from './config';
import { getSidePanelWindow } from '../windows/sidepanel';
import { IPC_CHANNELS, MeetingDocument, MeetingActionItem, TranscriptEntry } from '../../shared/types';
import { MeetingAiEngine, Suggestion } from './aiEngine';
import { buildDocumentContext } from './documents';
import { captureScreenshot } from '../capture/screenshot';
import { AI_MODEL } from '../settingsStore';
import { createMeeting, finalizeMeeting, saveTranscriptEntries } from '../db/meetingRepository';
import { ensureSessionExists, linkMeetingToSession, updateSessionTitle } from '../db/repository';
import { getStoredUser } from '../auth/tokenStore';
import { getCurrentSessionId } from '../session';

// ── State ──

export type MeetingState = 'idle' | 'prep' | 'recording' | 'ended';

let state: MeetingState = 'idle';
let meetingId: string | null = null;
let stt: SttClient | null = null;
let transcript: TranscriptBuffer | null = null;
let aiEngine: MeetingAiEngine | null = null;
let documents: MeetingDocument[] = [];
let context = '';
let startTime = 0;

// ── Getters ──

export function getMeetingState(): MeetingState {
  return state;
}

export function getMeetingId(): string | null {
  return meetingId;
}

export function getTranscript(): TranscriptBuffer | null {
  return transcript;
}

export function getDocuments(): MeetingDocument[] {
  return [...documents];
}

export function getContext(): string {
  return context;
}

// ── Helpers ──

function sendToPanel(channel: string, ...args: any[]): void {
  try {
    const panel = getSidePanelWindow();
    if (!panel || panel.isDestroyed()) return;
    if (panel.webContents.isDestroyed()) return;
    panel.webContents.send(channel, ...args);
  } catch (err: any) {
    // Don't let a panel-send race crash the main process.
    console.warn('[meeting] sendToPanel failed:', err?.message || err);
  }
}

function setState(newState: MeetingState): void {
  state = newState;
  sendToPanel(IPC_CHANNELS.MEETING_STATE, newState);
  console.log(`[meeting] State → ${newState}`);
}

// ── Lifecycle ──

/**
 * Enter meeting prep mode.
 */
export function startPrep(): void {
  // If a previous meeting was left in 'ended' state (user closed the summary
  // but didn't explicitly end), clean up fully before starting a fresh one.
  // Without this, a stale transcript/aiEngine from the prior meeting would
  // remain wired to the new meetingId and the new meeting would appear to
  // "resume" the old one.
  if (state === 'ended') {
    endMeeting();
  }
  if (state !== 'idle') {
    console.log('[meeting] Cannot start prep, current state:', state);
    return;
  }

  meetingId = nanoid();
  documents = [];
  context = '';
  transcript = new TranscriptBuffer(meetingId);
  aiEngine = new MeetingAiEngine();

  // Wire AI engine events → renderer
  aiEngine.on('auto:suggestion', (suggestion: Suggestion) => {
    sendToPanel(IPC_CHANNELS.MEETING_SUGGESTION, suggestion);
  });
  aiEngine.on('auto:silent', () => {
    // AI decided not to speak — nothing to send
  });
  aiEngine.on('auto:token', (token: string) => {
    sendToPanel('meeting:auto-token', token);
  });
  aiEngine.on('auto:done', () => {
    sendToPanel('meeting:auto-done');
  });
  aiEngine.on('action_item', (item: MeetingActionItem) => {
    sendToPanel(IPC_CHANNELS.MEETING_ACTION_ITEM, item);
  });
  aiEngine.on('user:thinking', () => {
    sendToPanel(IPC_CHANNELS.AI_STATE, 'thinking');
  });
  aiEngine.on('user:token', (token: string) => {
    sendToPanel(IPC_CHANNELS.SIDEPANEL_STREAM_TOKEN, token);
  });
  aiEngine.on('user:done', () => {
    sendToPanel(IPC_CHANNELS.AI_RESPONSE_COMPLETE);
    sendToPanel(IPC_CHANNELS.AI_STATE, 'idle');
  });
  aiEngine.on('user:cancelled', () => {
    sendToPanel(IPC_CHANNELS.AI_RESPONSE_COMPLETE);
    sendToPanel(IPC_CHANNELS.AI_STATE, 'idle');
  });
  aiEngine.on('user:error', (err: string) => {
    sendToPanel(IPC_CHANNELS.AI_ERROR, err);
    sendToPanel(IPC_CHANNELS.AI_STATE, 'idle');
  });

  setState('prep');
  console.log('[meeting] Prep started, id:', meetingId);
}

/**
 * Set the meeting context/goal.
 */
export function setMeetingContext(ctx: string): void {
  context = ctx;
}

/**
 * Add a document to the meeting.
 */
export function addDocument(doc: MeetingDocument): void {
  documents.push(doc);
  console.log(`[meeting] Document added: ${doc.fileName} (${doc.extractedText.length} chars)`);
}

/**
 * Remove a document from the meeting.
 */
export function removeDocument(docId: string): void {
  documents = documents.filter(d => d.id !== docId);
}

/**
 * Check audio permissions.
 */
export function checkAudioPermission(): PermissionStatus {
  return audioCapture.checkPermission();
}

/**
 * Request audio permissions.
 */
export async function requestAudioPermission(): Promise<boolean> {
  return audioCapture.requestPermission();
}

/**
 * Start recording — single multichannel Deepgram connection.
 * Stereo PCM: L=system audio (Them), R=mic (You).
 * Echo suppression: mic channel is silenced when system audio has energy.
 */
export function startRecording(): void {
  if (state !== 'prep') {
    console.log('[meeting] Cannot start recording, current state:', state);
    return;
  }

  const apiKey = getDeepgramApiKey();
  if (!apiKey) {
    sendToPanel(IPC_CHANNELS.MEETING_ERROR, 'Deepgram API key not configured');
    console.error('[meeting] No Deepgram API key');
    return;
  }

  // Check permissions
  const perm = audioCapture.checkPermission();
  if (perm === 'denied' || perm === 'unsupported') {
    sendToPanel(IPC_CHANNELS.MEETING_ERROR,
      perm === 'unsupported'
        ? 'Meeting Copilot requires macOS 13 or later'
        : 'Screen Recording and Microphone permissions are required. Please enable them in System Settings → Privacy & Security.'
    );
    return;
  }

  // Single multichannel STT connection
  stt = new SttClient({ apiKey });

  // Wire STT → transcript buffer
  stt.on('transcript', (event: TranscriptEvent) => {
    if (!transcript) return;
    transcript.addEvent(event);
  });

  stt.on('connected', () => {
    console.log('[meeting] STT connected, starting audio...');

    const started = audioCapture.start();
    if (!started) {
      sendToPanel(IPC_CHANNELS.MEETING_ERROR, 'Failed to start audio capture');
      stt?.disconnect();
      return;
    }

    startTime = Date.now();
    setState('recording');

    // Persist the meeting row now that recording has actually started — we
    // don't save abandoned prep sessions. User id may be missing in anonymous
    // mode; fall back to 'local' so history still works.
    if (meetingId) {
      try {
        const userId = String(getStoredUser()?.id || 'local');
        const sessionId = getCurrentSessionId();

        // Ensure the session row exists BEFORE inserting the meeting so
        // meetings.session_id has something to point at.
        if (sessionId) {
          try {
            ensureSessionExists(sessionId, AI_MODEL, userId);
          } catch (err) {
            console.warn('[meeting] ensureSessionExists failed:', err);
          }
        }

        // Meetings carry their session id at creation — many meetings can
        // share one session without any UPDATE-level overwriting.
        createMeeting(meetingId, userId, context, documents, sessionId);

        if (sessionId) {
          try {
            // Maintain the legacy sessions.meeting_id pointer so anything
            // still reading it keeps working. Multiple meetings → this
            // holds the most recent one.
            linkMeetingToSession(sessionId, meetingId);
            // Seed session title from meeting context, but only if the
            // session doesn't already have a title from prior activity.
            if (context && context.trim()) {
              try {
                const { getDb } = require('../db/connection');
                const row = getDb().prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string | null } | undefined;
                if (!row?.title) {
                  updateSessionTitle(sessionId, context.trim().slice(0, 80));
                }
              } catch {
                // If the lookup failed for any reason, fall through and seed.
                updateSessionTitle(sessionId, context.trim().slice(0, 80));
              }
            }
          } catch (err) {
            console.warn('[meeting] link-to-session failed:', err);
          }
        }
      } catch (err) {
        console.error('[meeting] Failed to persist meeting row:', err);
      }
    }
  });

  stt.on('error', (err: Error) => {
    console.error('[meeting] STT error:', err.message);
    sendToPanel(IPC_CHANNELS.MEETING_ERROR, `Speech recognition error: ${err.message}`);
  });

  stt.on('disconnected', (code: number) => {
    if (state === 'recording') {
      console.log('[meeting] STT disconnected, code:', code);
    }
  });

  // Wire transcript events → renderer
  transcript!.on('entry', (entry: TranscriptEntry) => {
    sendToPanel(IPC_CHANNELS.MEETING_TRANSCRIPT_UPDATE, entry);
  });

  // Wire transcript trigger → AI engine for auto-suggestions
  transcript!.on('trigger', (newEntries: TranscriptEntry[]) => {
    if (!aiEngine || !transcript) return;
    console.log(`[meeting] AI trigger: ${newEntries.length} new entries`);
    const fullText = transcript.getFormattedText();
    aiEngine.processTranscript(newEntries, fullText, documents, context)
      .then(() => transcript?.markAiProcessed())
      .catch(() => {}); // errors handled via events
  });

  // Send raw stereo audio directly to Deepgram — no processing.
  // Deepgram multichannel handles L=system R=mic natively.
  audioCapture.on('chunk', (chunk: Buffer) => {
    if (stt && stt.isConnected()) {
      stt.sendAudio(chunk);
    }
  });

  stt.connect();
}

/**
 * Stop recording — end audio capture + STT, generate summary.
 */
export function stopRecording(): void {
  if (state !== 'recording') {
    console.log('[meeting] Cannot stop, current state:', state);
    return;
  }

  console.log('[meeting] Stopping recording...');

  // Stop audio capture
  audioCapture.stop();
  audioCapture.removeAllListeners('chunk');

  // Disconnect STT
  if (stt) {
    stt.disconnect();
    stt.removeAllListeners();
    stt = null;
  }

  // Cancel any pending transcript debounce
  if (transcript) {
    transcript.cancelDebounce();
  }

  // Cancel any running AI requests
  if (aiEngine) {
    aiEngine.cancelAuto();
    aiEngine.cancelUser();
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`[meeting] Recording stopped. Duration: ${duration}s, Entries: ${transcript?.length || 0}`);

  setState('ended');

  // Generate final summary — persistence happens inside, after the summary
  // arrives (or fails). If the user tears down the meeting before the
  // summary completes, endMeeting() has a safety-net persist.
  generateFinalSummary();
}

/**
 * End the meeting and go back to idle.
 */
export function endMeeting(): void {
  // Clean up
  if (state === 'recording') {
    stopRecording();
  }

  // Safety-net persist: if the user tears down before the final summary
  // arrived, we still save whatever transcript we have so the meeting isn't
  // lost. Harmless no-op if persistMeetingToDb already ran.
  if (meetingId && transcript && transcript.length > 0) {
    try {
      persistMeetingToDb(null);
    } catch {}
  }

  if (transcript) {
    transcript.removeAllListeners();
    transcript.clear();
    transcript = null;
  }

  if (aiEngine) {
    aiEngine.reset();
    aiEngine = null;
  }

  documents = [];
  context = '';
  meetingId = null;
  startTime = 0;

  setState('idle');
  console.log('[meeting] Meeting ended');
}

/**
 * Send a user message during the meeting (Channel 2 — priority).
 * Optionally takes a screenshot if withScreenshot is true.
 */
export async function sendMeetingMessage(text: string, withScreenshot = false): Promise<void> {
  if (state !== 'recording' || !aiEngine || !transcript) {
    console.log('[meeting] Cannot send message, state:', state);
    return;
  }

  let screenshot: string | null = null;
  if (withScreenshot) {
    try {
      const buf = await captureScreenshot();
      screenshot = buf.toString('base64');
      sendToPanel(IPC_CHANNELS.SESSION_SCREENSHOT, screenshot);
    } catch (err) {
      console.error('[meeting] Screenshot failed:', err);
    }
  }

  const fullText = transcript.getFormattedText();

  try {
    await aiEngine.processUserMessage(text, fullText, documents, context, screenshot);
  } catch (err: any) {
    console.error('[meeting] User message error:', err.message);
  }
}

/**
 * Stop AI generation during meeting (either channel).
 */
export function stopMeetingAi(): void {
  if (aiEngine) {
    aiEngine.cancelUser();
    aiEngine.cancelAuto();
    sendToPanel(IPC_CHANNELS.AI_RESPONSE_COMPLETE);
    sendToPanel(IPC_CHANNELS.AI_STATE, 'idle');
  }
}

/**
 * Get action items detected so far.
 */
export function getMeetingActionItems(): MeetingActionItem[] {
  return aiEngine?.getActionItems() || [];
}

// ── Final summary generation ──

async function generateFinalSummary(): Promise<void> {
  if (!transcript || !aiEngine) return;

  const fullText = transcript.getFormattedText();
  if (!fullText) {
    sendToPanel(IPC_CHANNELS.MEETING_SUMMARY, null);
    return;
  }

  const docContext = buildDocumentContext(documents);
  const actionItems = aiEngine.getActionItems();

  const messages = [
    {
      role: 'system',
      content: `You are a meeting summarizer. Generate a structured meeting summary in the following JSON format:
{
  "overview": "2-3 sentence summary of the meeting",
  "keyDecisions": ["decision 1", "decision 2"],
  "actionItems": [{"task": "task description", "owner": "person name or 'You'/'Them'", "done": false}],
  "followUps": ["follow-up item 1", "follow-up item 2"]
}
Return ONLY valid JSON, no markdown, no extra text.`
    },
    {
      role: 'user',
      content: [
        context ? `MEETING CONTEXT: ${context}` : '',
        docContext ? `DOCUMENTS DISCUSSED:\n${docContext.slice(0, 5000)}` : '',
        actionItems.length > 0
          ? `ACTION ITEMS DETECTED DURING MEETING:\n${actionItems.map(a => `- ${a.task} (${a.owner})`).join('\n')}`
          : '',
        `FULL TRANSCRIPT:\n${fullText}`,
        '\nGenerate the meeting summary JSON.',
      ].filter(Boolean).join('\n\n'),
    },
  ];

  try {
    console.log('[meeting] Generating final summary...');

    let response = '';
    const { streamCompletion } = require('../ai/stream');

    await streamCompletion({
      messages,
      model: AI_MODEL,
      temperature: 0.2,
      maxTokens: 1500,
      onToken: (token: string) => { response += token; },
    });

    // Parse JSON response
    response = response.trim();
    // Strip markdown code fences if present
    if (response.startsWith('```')) {
      response = response.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const summary = JSON.parse(response);
    sendToPanel(IPC_CHANNELS.MEETING_SUMMARY, summary);
    console.log('[meeting] Summary generated');

    persistMeetingToDb(summary);
  } catch (err: any) {
    console.error('[meeting] Summary generation failed:', err.message);
    sendToPanel(IPC_CHANNELS.MEETING_SUMMARY, null);
    // Still persist the transcript — the user may want to read it even
    // if the summary failed.
    persistMeetingToDb(null);
  }
}

/**
 * Persist the meeting row, transcript and summary to local SQLite. Called
 * after summary generation (success or failure). Silent on DB errors so the
 * UI isn't blocked — the meeting already played out in memory.
 */
function persistMeetingToDb(summary: any): void {
  if (!meetingId || !transcript) return;

  try {
    const entries = transcript.getAll();
    const duration = Math.round((Date.now() - startTime) / 1000);

    // Derive a title: prefer the prep context, else first bit of overview,
    // else a timestamp fallback.
    let title = (context || '').trim().slice(0, 80);
    if (!title && summary?.overview) {
      title = String(summary.overview).trim().slice(0, 80);
    }
    if (!title) {
      title = `Meeting ${new Date().toLocaleString()}`;
    }

    finalizeMeeting(meetingId, duration, title, summary || null);
    saveTranscriptEntries(meetingId, entries);
    console.log(`[meeting] Persisted to DB: ${meetingId} (${entries.length} entries, ${duration}s)`);
  } catch (err) {
    console.error('[meeting] Failed to persist meeting:', err);
  }
}

/**
 * Get meeting duration in seconds (0 if not recording).
 */
export function getMeetingDuration(): number {
  if (state !== 'recording' || !startTime) return 0;
  return Math.round((Date.now() - startTime) / 1000);
}
