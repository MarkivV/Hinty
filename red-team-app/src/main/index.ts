import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { createGeneralWindow, getGeneralWindow, updateGeneralContentProtection } from './windows/general';
import { getSidePanelWindow, enableFocus, disableFocus, updateContentProtection, destroySidePanelWindow } from './windows/sidepanel';
import { initCapture } from './capture/index';
import { captureScreenshot } from './capture/screenshot';
import { getSettings, updateSettings } from './settingsStore';
import { sendMessage, stopGenerating } from './session';
import { fireTrigger, unregisterHotkeys } from './hotkeys';
import { initDb, startSession, endCurrentSession, continueExistingSession, getAppMode } from './appState';
import { closeConnection } from './db/connection';
import { getRecentSessions, getSessionMessages, deleteSession, wipeLocalCache, syncSessionList, getUnifiedHistory } from './db/repository';
import {
  getRecentMeetings,
  getMeetingById,
  getMeetingTranscript,
  getMeetingsForSession,
  deleteMeeting,
  updateMeetingTitle,
} from './db/meetingRepository';
import { IPC_CHANNELS } from '../shared/types';
import { login, register, logout, getAuthState, refreshProfile, isAuthenticated, stopCallbackServer, openUpgradeCheckout, openBillingPortal, handleDeepLink } from './auth/authClient';
import { getStoredUser } from './auth/tokenStore';
import { checkForUpdates, downloadUpdate, installUpdate, getUpdateState } from './updater';
import { startFocusTimer, pauseTimer, resumeTimer, endTimer, skipBreak, getTimerState } from './focusTimer';
import {
  startPrep, startRecording, stopRecording, endMeeting,
  setMeetingContext, addDocument, removeDocument,
  checkAudioPermission, requestAudioPermission,
  getMeetingState, getMeetingDuration,
  sendMeetingMessage, stopMeetingAi, getMeetingActionItems
} from './meeting/index';
import { processDocument, getSupportedExtensions } from './meeting/documents';

/**
 * Build the meeting portion of a unified detail payload. Shared between the
 * session-linked and orphan-meeting code paths in history:get-unified-detail.
 */
function buildMeetingDetail(meetingId: string): {
  id: string;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  duration: number;
  context: string | null;
  documents: any[];
  summary: { overview: string; keyDecisions: string[]; actionItems: any[]; followUps: string[] };
  transcript: Array<{ id: string; meetingId: string; timestamp: number; speaker: string; channel: number; text: string }>;
} | null {
  const row = getMeetingById(meetingId);
  if (!row) return null;

  const parse = <T>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
  };

  const transcript = getMeetingTranscript(meetingId).map((t) => ({
    id: String(t.id),
    meetingId: t.meeting_id,
    timestamp: t.timestamp_sec,
    speaker: t.speaker,
    channel: t.channel,
    text: t.text,
  }));

  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    duration: row.duration,
    context: row.context,
    documents: parse<any[]>(row.documents, []),
    summary: {
      overview: row.overview || '',
      keyDecisions: parse<string[]>(row.key_decisions, []),
      actionItems: parse<any[]>(row.action_items, []),
      followUps: parse<string[]>(row.follow_ups, []),
    },
    transcript,
  };
}

// Note: Don't use app.setName() — it confuses macOS TCC permissions
// (screen recording permission won't persist between launches)

// Prevent unhandled exceptions from crashing the app
process.on('uncaughtException', (err) => {
  console.error('[crash-guard] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[crash-guard] Unhandled rejection:', reason);
});

// Register as default handler for hinty:// protocol
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('hinty', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('hinty');
}

// Handle deep link on macOS (app already running)
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function resolveActionPrompt(buttonId: string): string | null {
  const settings = getSettings();
  const template = settings.promptTemplates.find(t => t.id === settings.activeTemplateId);
  if (!template) return null;
  const button = template.buttons.find(b => b.id === buttonId);
  return button?.prompt || null;
}

function registerIpcHandlers() {
  // App info
  ipcMain.handle('app:get-version', () => app.getVersion());

  // Settings
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:update', (_event, partial) => {
    const updated = updateSettings(partial);
    // Notify sidepanel when settings change (e.g. hotkeys)
    const panel = getSidePanelWindow();
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send('settings:changed', updated);
    }
    return updated;
  });

  // Session lifecycle
  ipcMain.on('session:start', async () => {
    console.log('[ipc] session:start');
    await startSession();
  });

  ipcMain.on('session:end', async () => {
    console.log('[ipc] session:end');
    await endCurrentSession();
  });

  ipcMain.on('session:trigger-assist', () => {
    fireTrigger();
  });

  // Stop AI generation
  ipcMain.on('ai:stop', () => {
    console.log('[ipc] ai:stop');
    stopGenerating();
  });

  // ── Meeting Copilot ──

  ipcMain.on('meeting:start-prep', async () => {
    console.log('[ipc] meeting:start-prep');
    // Meeting Copilot is a Max-tier feature.
    const user = getStoredUser();
    if (!user) {
      const panel = getSidePanelWindow();
      if (panel && !panel.isDestroyed()) {
        panel.webContents.send('tier:gate-blocked', { feature: 'meeting', reason: 'signin-required' });
      }
      return;
    }
    if (user.tier !== 'max') {
      const panel = getSidePanelWindow();
      if (panel && !panel.isDestroyed()) {
        panel.webContents.send('tier:gate-blocked', { feature: 'meeting', reason: 'upgrade-required', currentTier: user.tier });
      }
      return;
    }
    // Ensure there's an active session so the meeting attaches to it in
    // history. If the user opened the meeting flow from the landing page
    // without starting a session first, spin one up.
    if (getAppMode() !== 'session') {
      await startSession();
    }
    startPrep();
  });

  ipcMain.on('meeting:start-recording', () => {
    console.log('[ipc] meeting:start-recording');
    startRecording();
  });

  ipcMain.on('meeting:stop', () => {
    console.log('[ipc] meeting:stop');
    stopRecording();
  });

  ipcMain.on('meeting:end', () => {
    console.log('[ipc] meeting:end');
    endMeeting();
  });

  ipcMain.on('meeting:set-context', (_event, ctx: string) => {
    setMeetingContext(ctx);
  });

  ipcMain.handle('meeting:upload-doc', async () => {
    const exts = getSupportedExtensions();
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: exts },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) return [];

    const docs = [];
    for (const filePath of result.filePaths) {
      try {
        const doc = await processDocument(filePath);
        addDocument(doc);
        docs.push({ id: doc.id, fileName: doc.fileName, fileType: doc.fileType, chars: doc.extractedText.length });
      } catch (err: any) {
        console.error(`[meeting] Failed to process ${filePath}:`, err.message);
      }
    }
    return docs;
  });

  ipcMain.on('meeting:remove-doc', (_event, docId: string) => {
    removeDocument(docId);
  });

  // ── Session-level documents (Max tier) ──
  // These are distinct from meeting documents: they attach to the chat
  // session itself and (in future) are injected into chat AI context.
  // Tier-gated: free/pro see an upgrade CTA.

  ipcMain.handle('session:upload-document', async () => {
    const user = getStoredUser();
    if (!user) {
      return { ok: false, reason: 'signin-required' };
    }
    if (user.tier !== 'max') {
      return { ok: false, reason: 'upgrade-required', currentTier: user.tier };
    }

    // Ensure there's an active session to attach to.
    if (getAppMode() !== 'session') {
      return { ok: false, reason: 'no-session' };
    }

    const { getCurrentSessionId } = await import('./session');
    const sessionId = getCurrentSessionId();
    if (!sessionId) return { ok: false, reason: 'no-session' };

    const exts = getSupportedExtensions();
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: exts }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, docs: [] };
    }

    // Lazy-create session row so the FK constraint holds.
    const { ensureSessionExists, insertSessionDocument, getSessionDocuments } =
      await import('./db/repository');
    const { AI_MODEL: model } = await import('./settingsStore');
    ensureSessionExists(sessionId, model, String(user.id));

    const existing = getSessionDocuments(sessionId);
    let seq = existing.length;

    const docs: any[] = [];
    for (const filePath of result.filePaths) {
      try {
        const doc = await processDocument(filePath);
        insertSessionDocument(doc.id, sessionId, doc.fileName, doc.fileType, doc.extractedText, seq++);
        docs.push({ id: doc.id, fileName: doc.fileName, fileType: doc.fileType, chars: doc.extractedText.length });
      } catch (err: any) {
        console.error(`[session-docs] Failed to process ${filePath}:`, err.message);
      }
    }
    return { ok: true, docs };
  });

  ipcMain.handle('session:list-documents', async () => {
    try {
      const { getCurrentSessionId } = await import('./session');
      const sessionId = getCurrentSessionId();
      if (!sessionId) return [];
      const { getSessionDocuments } = await import('./db/repository');
      return getSessionDocuments(sessionId).map(d => ({
        id: d.id,
        fileName: d.file_name,
        fileType: d.file_type,
        chars: (d.extracted_text || '').length,
      }));
    } catch {
      return [];
    }
  });

  ipcMain.on('session:remove-document', (_event, docId: string) => {
    try {
      const { deleteSessionDocument } = require('./db/repository');
      deleteSessionDocument(docId);
    } catch (err: any) {
      console.error('[ipc] session:remove-document failed:', err.message);
    }
  });

  ipcMain.handle('meeting:check-permission', async () => {
    return checkAudioPermission();
  });

  ipcMain.handle('meeting:request-permission', async () => {
    return requestAudioPermission();
  });

  ipcMain.handle('meeting:get-state', async () => {
    return {
      state: getMeetingState(),
      duration: getMeetingDuration(),
      actionItems: getMeetingActionItems(),
    };
  });

  // Meeting: user sends a message during meeting
  ipcMain.on('meeting:chat-send', async (_event, data: { text: string; withScreenshot?: boolean }) => {
    console.log('[ipc] meeting:chat-send', data.text.slice(0, 80));
    await sendMeetingMessage(data.text, data.withScreenshot);
  });

  // Meeting: stop AI generation
  ipcMain.on('meeting:stop-ai', () => {
    console.log('[ipc] meeting:stop-ai');
    stopMeetingAi();
  });

  // ── Meeting History ──

  ipcMain.handle(IPC_CHANNELS.MEETING_HISTORY_LIST_REQ, async () => {
    try {
      const userId = String(getStoredUser()?.id || 'local');
      const rows = getRecentMeetings(userId, 100);
      return rows.map((r) => ({
        id: r.id,
        title: r.title || 'Untitled meeting',
        startedAt: r.started_at,
        endedAt: r.ended_at,
        duration: r.duration,
        context: r.context,
        overviewPreview: (r.overview || '').slice(0, 140),
      }));
    } catch (err: any) {
      console.error('[ipc] history-list failed:', err.message);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_HISTORY_DETAIL_REQ, async (_e, meetingId: string) => {
    try {
      const row = getMeetingById(meetingId);
      if (!row) return null;

      const entries = getMeetingTranscript(meetingId).map((t) => ({
        id: String(t.id),
        meetingId: t.meeting_id,
        timestamp: t.timestamp_sec,
        speaker: t.speaker,
        channel: t.channel,
        text: t.text,
      }));

      const parse = <T>(s: string | null, fallback: T): T => {
        if (!s) return fallback;
        try { return JSON.parse(s); } catch { return fallback; }
      };

      return {
        id: row.id,
        title: row.title,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        duration: row.duration,
        context: row.context,
        documents: parse<any[]>(row.documents, []),
        summary: {
          overview: row.overview || '',
          keyDecisions: parse<string[]>(row.key_decisions, []),
          actionItems: parse<any[]>(row.action_items, []),
          followUps: parse<string[]>(row.follow_ups, []),
        },
        transcript: entries,
      };
    } catch (err: any) {
      console.error('[ipc] history-detail failed:', err.message);
      return null;
    }
  });

  ipcMain.on(IPC_CHANNELS.MEETING_HISTORY_DELETE, (_e, meetingId: string) => {
    try {
      deleteMeeting(meetingId);
    } catch (err: any) {
      console.error('[ipc] history-delete failed:', err.message);
    }
  });

  ipcMain.on(IPC_CHANNELS.MEETING_HISTORY_RENAME, (_e, payload: { id: string; title: string }) => {
    try {
      updateMeetingTitle(payload.id, payload.title);
    } catch (err: any) {
      console.error('[ipc] history-rename failed:', err.message);
    }
  });

  ipcMain.on('session:continue', async (_event, sessionId: string) => {
    console.log('[ipc] session:continue', sessionId);
    await continueExistingSession(sessionId);
  });

  // Side panel focus management — native panel handles non-activation,
  // this just toggles whether keyboard input is accepted.
  ipcMain.on('panel:request-focus', () => {
    enableFocus();
  });
  ipcMain.on('panel:release-focus', () => {
    disableFocus();
  });

  // Click-through for transparent areas of the side panel
  ipcMain.on('panel:set-clickthrough', (_event, ignore: boolean) => {
    const panel = getSidePanelWindow();
    if (!panel || panel.isDestroyed()) return;
    if (ignore) {
      panel.setIgnoreMouseEvents(true, { forward: true });
    } else {
      panel.setIgnoreMouseEvents(false);
    }
  });

  // Custom window drag (avoids -webkit-app-region which bypasses native panel)
  ipcMain.on('panel:start-drag', (_event, startX: number, startY: number) => {
    const panel = getSidePanelWindow();
    if (!panel || panel.isDestroyed()) return;
    const [wx, wy] = panel.getPosition();
    // Store offset between mouse and window origin
    (panel as any).__dragOffsetX = startX - wx;
    (panel as any).__dragOffsetY = startY - wy;
  });
  ipcMain.on('panel:drag-move', (_event, screenX: number, screenY: number) => {
    const panel = getSidePanelWindow();
    if (!panel || panel.isDestroyed()) return;
    const ox = (panel as any).__dragOffsetX ?? 0;
    const oy = (panel as any).__dragOffsetY ?? 0;
    panel.setPosition(Math.round(screenX - ox), Math.round(screenY - oy));
  });

  // Content protection toggle — keeps the store, both windows' OS-level
  // content-protection flags, and both renderers' UI state in lockstep.
  ipcMain.on('settings:toggle-content-protection', (_event, enabled: boolean) => {
    try {
      const updated = updateSettings({ contentProtection: enabled });
      updateContentProtection(enabled);
      updateGeneralContentProtection(enabled);
      // Broadcast so the OTHER window's UI (sidepanel button / general toggle)
      // picks up the change and stays in sync.
      const panel = getSidePanelWindow();
      if (panel && !panel.isDestroyed()) {
        panel.webContents.send('settings:changed', updated);
      }
      const general = getGeneralWindow();
      if (general && !general.isDestroyed()) {
        general.webContents.send('settings:changed', updated);
      }
    } catch (err) {
      console.error('[settings] toggle-content-protection failed:', err);
    }
  });

  // History
  ipcMain.handle('history:get-sessions', async () => {
    try {
      const user = getStoredUser();
      if (!user?.id) return [];
      return getRecentSessions(String(user.id), 50);
    } catch {
      return [];
    }
  });

  ipcMain.handle('history:get-messages', async (_event, sessionId: string) => {
    try {
      return await getSessionMessages(sessionId);
    } catch {
      return [];
    }
  });

  ipcMain.handle('history:delete-session', async (_event, sessionId: string) => {
    try {
      deleteSession(sessionId);
      return true;
    } catch {
      return false;
    }
  });

  // ── Unified history (sessions + meetings rolled into one list) ──

  ipcMain.handle('history:list-unified', async () => {
    try {
      const user = getStoredUser();
      const userId = String(user?.id || 'local');
      const rows = getUnifiedHistory(userId, 100);
      return rows.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        // Prefer explicit session title; fall back to meeting title.
        title: r.title || r.meet_title || null,
        messageCount: r.message_count || 0,
        hasMeeting: (r.meeting_count || 0) > 0 || !!r.meeting_id,
        meetingCount: r.meeting_count || 0,
        hasDocuments: !!r.has_documents,
        // For orphan meetings, id === meeting_id so the UI can open + delete
        // them via the meeting-only path. These also lack chat messages.
        isMeetingOnly: !!r.meeting_id && r.id === r.meeting_id && (r.message_count || 0) === 0,
        meetingId: r.meeting_id,
        meetingDuration: r.meet_duration,
        overviewPreview: (r.meet_overview || '').slice(0, 140),
      }));
    } catch (err: any) {
      console.error('[ipc] history:list-unified failed:', err.message);
      return [];
    }
  });

  /**
   * Unified detail payload. Input: either a session id or (for orphan
   * meetings) the meeting id. Returns a consistent shape the UI can render:
   * { id, title, startedAt, duration, messages[], meeting: { transcript[], summary } | null }
   */
  ipcMain.handle('history:get-unified-detail', async (_event, id: string) => {
    try {
      // First, is this a session id?
      const { getDb } = await import('./db/connection');
      const db = getDb();
      const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
        | { id: string; started_at: string; ended_at: string | null; title: string | null; meeting_id: string | null }
        | undefined;

      if (sessionRow) {
        const messages = await getSessionMessages(sessionRow.id);

        // Collect every meeting tied to this session. Canonical: meetings.session_id.
        // Fallback: legacy sessions.meeting_id for rows created before the
        // column existed (only add if not already in the primary list).
        const primary = getMeetingsForSession(sessionRow.id);
        const collected: any[] = [];
        const seen = new Set<string>();
        for (const m of primary) {
          const built = buildMeetingDetail(m.id);
          if (built) { collected.push(built); seen.add(m.id); }
        }
        if (sessionRow.meeting_id && !seen.has(sessionRow.meeting_id)) {
          const legacy = buildMeetingDetail(sessionRow.meeting_id);
          if (legacy) collected.push(legacy);
        }
        // Back-compat field: first/only meeting (legacy UI paths read this).
        const primaryMeeting = collected.length > 0 ? collected[0] : null;

        return {
          kind: 'session',
          id: sessionRow.id,
          title: sessionRow.title || primaryMeeting?.title || null,
          startedAt: sessionRow.started_at,
          endedAt: sessionRow.ended_at,
          messages,
          meeting: primaryMeeting,       // legacy single-meeting field
          meetings: collected,           // NEW: every meeting in this session
        };
      }

      // Fall back to treating id as a meeting id (orphan meeting).
      const meeting = buildMeetingDetail(id);
      if (meeting) {
        return {
          kind: 'meeting-only',
          id,
          title: meeting.title,
          startedAt: meeting.startedAt,
          endedAt: meeting.endedAt,
          messages: [],
          meeting,
          meetings: [meeting],
        };
      }

      return null;
    } catch (err: any) {
      console.error('[ipc] history:get-unified-detail failed:', err.message);
      return null;
    }
  });

  ipcMain.handle('history:delete-unified', async (_event, id: string) => {
    try {
      const { getDb } = await import('./db/connection');
      const db = getDb();
      const sessionRow = db.prepare('SELECT meeting_id FROM sessions WHERE id = ?').get(id) as
        | { meeting_id: string | null }
        | undefined;

      if (sessionRow) {
        // Purge every meeting attached to this session (new session_id FK
        // and legacy meeting_id pointer). Transcripts cascade via FK.
        const meetings = getMeetingsForSession(id);
        for (const m of meetings) {
          try { deleteMeeting(m.id); } catch {}
        }
        if (sessionRow.meeting_id) {
          try { deleteMeeting(sessionRow.meeting_id); } catch {}
        }
        deleteSession(id);
        return true;
      }

      // Orphan meeting path
      deleteMeeting(id);
      return true;
    } catch (err: any) {
      console.error('[ipc] history:delete-unified failed:', err.message);
      return false;
    }
  });

  // Chat: user sends a message or quick action
  ipcMain.on('sidepanel:chat-send', async (_event, data) => {
    if (getAppMode() !== 'session') return;

    const text = data.type === 'action'
      ? resolveActionPrompt(data.action) || data.action
      : data.text;

    console.log('[chat]', text.slice(0, 80));
    await sendMessage(text);
  });

  // Knowledge base: upload
  ipcMain.on('settings:upload-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'txt'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return;

    const settings = getSettings();
    const appDataDir = path.join(app.getPath('userData'), 'knowledge-base');
    if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });

    const newFiles = [...settings.knowledgeBaseFiles];
    for (const filePath of result.filePaths) {
      const destPath = path.join(appDataDir, path.basename(filePath));
      fs.copyFileSync(filePath, destPath);
      if (!newFiles.includes(destPath)) newFiles.push(destPath);
    }

    const updated = updateSettings({ knowledgeBaseFiles: newFiles });

    // Notify whichever window is showing settings
    const general = getGeneralWindow();
    if (general && !general.isDestroyed()) {
      general.webContents.send('settings:files-updated', updated.knowledgeBaseFiles);
    }
    const panel = getSidePanelWindow();
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send('settings:files-updated', updated.knowledgeBaseFiles);
    }
  });

  // Auth
  ipcMain.handle('auth:get-state', () => getAuthState());
  // Alias used by sidepanel tier gating — same payload as auth:get-state
  ipcMain.handle('auth:status', () => getAuthState());
  ipcMain.on('auth:login', () => { login(); });
  ipcMain.on('auth:register', () => { register(); });
  ipcMain.on('auth:logout', () => {
    try { wipeLocalCache(); } catch (err) { console.warn('[logout] Cache wipe failed:', err); }
    logout();
    const general = getGeneralWindow();
    if (general && !general.isDestroyed()) {
      general.webContents.send('auth:state-changed', getAuthState());
    }
  });
  ipcMain.handle('auth:refresh', async () => {
    await refreshProfile();
    return getAuthState();
  });

  // Stripe / Subscription
  ipcMain.on('stripe:upgrade', (_event, plan?: 'pro' | 'max') => { openUpgradeCheckout(plan); });
  ipcMain.on('stripe:portal', () => { openBillingPortal(); });

  // Auto-updater
  ipcMain.handle('updater:get-state', () => getUpdateState());
  ipcMain.on('updater:check', () => { checkForUpdates(); });
  ipcMain.on('updater:download', () => { downloadUpdate(); });
  ipcMain.on('updater:install', () => { installUpdate(); });

  // Focus timer
  ipcMain.handle('timer:get-state', () => getTimerState());
  ipcMain.on('timer:start', (_event, minutes?: number) => { startFocusTimer(minutes); });
  ipcMain.on('timer:pause', () => { pauseTimer(); });
  ipcMain.on('timer:resume', () => { resumeTimer(); });
  ipcMain.on('timer:end', () => { endTimer(); });
  ipcMain.on('timer:skip-break', () => { skipBreak(); });

  // Open external URL in default browser
  ipcMain.on('open-external', (_event, url: string) => {
    shell.openExternal(url);
  });

  // Knowledge base: remove
  ipcMain.on('settings:remove-file', (_event, index: number) => {
    const settings = getSettings();
    const files = [...settings.knowledgeBaseFiles];
    if (index >= 0 && index < files.length) {
      files.splice(index, 1);
      const updated = updateSettings({ knowledgeBaseFiles: files });

      const general = getGeneralWindow();
      if (general && !general.isDestroyed()) {
        general.webContents.send('settings:files-updated', updated.knowledgeBaseFiles);
      }
      const panel = getSidePanelWindow();
      if (panel && !panel.isDestroyed()) {
        panel.webContents.send('settings:files-updated', updated.knowledgeBaseFiles);
      }
    }
  });
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}
app.on('second-instance', (_event, argv) => {
  const general = getGeneralWindow();
  if (general && !general.isDestroyed()) {
    if (general.isMinimized()) general.restore();
    general.focus();
  }
  // Handle deep link URL passed via argv (Windows/Linux)
  const deepLink = argv.find(arg => arg.startsWith('hinty://'));
  if (deepLink) handleDeepLink(deepLink);
});

app.whenReady().then(async () => {
  registerIpcHandlers();

  // Initialize database (non-blocking — app works without it)
  await initDb();

  // Create the General window (main hub)
  createGeneralWindow();

  // Request notification permission on first launch (macOS shows permission dialog)
  if (Notification.isSupported()) {
    const settings = getSettings();
    if (settings.notifications.focusComplete || settings.notifications.breakOver) {
      const n = new Notification({
        title: 'Hinty is ready',
        silent: true,
      });
      n.show();
    }
  }

  // Refresh auth profile and sync session history from cloud
  if (isAuthenticated()) {
    refreshProfile().catch(() => {});
    const user = getStoredUser();
    if (user?.id) {
      syncSessionList(String(user.id))
        .then(() => {
          const win = getGeneralWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('history:updated');
          }
        })
        .catch(err => console.warn('[startup] Session sync failed:', err));
    }
  }

  // Periodic profile refresh (picks up tier changes from Stripe webhooks)
  setInterval(() => {
    if (isAuthenticated()) {
      refreshProfile().catch(() => {});
    }
  }, 5 * 60 * 1000); // every 5 minutes

  // Refresh profile when the general window regains focus
  const general = getGeneralWindow();
  if (general) {
    general.on('focus', () => {
      if (isAuthenticated()) {
        refreshProfile().catch(() => {});
      }
    });
  }

  // Auto-updates: check 10s after launch, every 30 min, and on window focus
  if (app.isPackaged) {
    setTimeout(() => checkForUpdates(), 10_000);
    setInterval(() => checkForUpdates(), 30 * 60 * 1000);
    const generalWin = getGeneralWindow();
    if (generalWin) {
      generalWin.on('focus', () => checkForUpdates());
    }
  }

  // Initialize capture pipeline (lightweight — OCR worker is no longer loaded at startup)
  await initCapture();

  // Warm up desktopCapturer — first call often returns empty/invalid data
  try {
    await captureScreenshot();
    console.log('[startup] Screenshot warm-up complete');
  } catch (e) {
    console.warn('[startup] Screenshot warm-up failed (permissions?):', e);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createGeneralWindow();
    } else if (getAppMode() === 'idle') {
      const general = getGeneralWindow();
      if (general && !general.isDestroyed()) {
        general.show();
        general.focus();
      }
    } else if (getAppMode() === 'session') {
      // Clicking dock icon during session — end session and show general
      endCurrentSession();
    }
  });
});

// Use 'before-quit' instead of 'will-quit' — it fires earlier and can be
// cancelled to give async cleanup time to complete. 'will-quit' with an async
// callback is unsafe because Electron doesn't await it.
// Guard against re-entrance if before-quit fires twice (can happen when we
// preventDefault + re-call app.quit() on macOS dock-quit).
let quitInProgress = false;

app.on('before-quit', (event) => {
  // Always unregister global shortcuts IMMEDIATELY so they can't fire after
  // we've started tearing down windows (stale callbacks on destroyed
  // webContents are a common SIGSEGV source).
  unregisterHotkeys();
  stopCallbackServer();

  if (getAppMode() === 'session') {
    if (quitInProgress) return;
    quitInProgress = true;
    event.preventDefault();
    endCurrentSession().finally(() => {
      destroySidePanelWindow();
      closeConnection();
      app.quit();
    });
  } else {
    destroySidePanelWindow();
    closeConnection();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
