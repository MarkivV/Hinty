import { app } from 'electron';
import { AppMode } from '../shared/types';
import { createSidePanelWindow, getSidePanelWindow, hideSidePanel, showSidePanel } from './windows/sidepanel';
import { showGeneralWindow, hideGeneralWindow, getGeneralWindow } from './windows/general';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { resetSession, restoreSession, getCurrentSessionId, getExportableMessages, getLastActivityAt, RestoredMessage } from './session';
import { getSettings, AI_MODEL } from './settingsStore';
import { initDatabase } from './db/schema';
import { endSession as dbEndSession, saveAllMessages, reopenSession, getSessionMessages, deleteSessionIfEmpty } from './db/repository';
import { pruneIncompleteMeetings } from './db/meetingRepository';
import { getStoredUser } from './auth/tokenStore';
import { IPC_CHANNELS } from '../shared/types';

let appMode: AppMode = 'idle';
let inactivityTimer: ReturnType<typeof setInterval> | null = null;

const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export function getAppMode(): AppMode {
  return appMode;
}

export function initDb(): void {
  try {
    initDatabase();
    pruneIncompleteMeetings(30);
    console.log('[appState] SQLite initialized');
  } catch (err) {
    console.error('[appState] Failed to initialize SQLite:', err);
  }
}

export async function startSession(): Promise<void> {
  if (appMode === 'session') return;

  appMode = 'session';
  console.log('[appState] Starting session');

  // NOTE: session row is now lazy-created on first message / first meeting
  // (see ensureSessionExists in session.ts and meeting/index.ts). This keeps
  // "opened panel then closed with nothing" sessions out of history.
  resetSession();

  hideGeneralWindow();
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  const panel = getSidePanelWindow();
  if (!panel || panel.isDestroyed()) {
    createSidePanelWindow();
  } else {
    panel.webContents.send('session:cleared');
    showSidePanel();
  }

  registerHotkeys();
  startInactivityTimer();
}

export async function continueExistingSession(sessionId: string): Promise<void> {
  // End current session first if one is active
  if (appMode === 'session') {
    await endCurrentSession();
  }

  // If a meeting was left running/ended from before, reset it so the restored
  // session doesn't carry stale meeting UI. This avoids the "pressed Continue
  // and a meeting immediately appeared" footgun.
  try {
    const { getMeetingState, endMeeting } = await import('./meeting/index');
    if (getMeetingState() !== 'idle') {
      endMeeting();
    }
  } catch (err) {
    console.warn('[appState] Failed to reset meeting before continue:', err);
  }

  appMode = 'session';
  console.log('[appState] Continuing session:', sessionId);

  // Load messages from DB
  const messages = await getSessionMessages(sessionId);

  // Restore session state in memory
  restoreSession(sessionId, messages as RestoredMessage[]);

  // Reopen the session in DB (clear ended_at)
  reopenSession(sessionId);

  hideGeneralWindow();
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  let panelIsNew = false;
  const panel = getSidePanelWindow();
  if (!panel || panel.isDestroyed()) {
    createSidePanelWindow();
    panelIsNew = true;
  } else {
    panel.webContents.send('session:cleared');
    showSidePanel();
  }

  // Send restored messages to the side panel once it's ready
  const targetPanel = getSidePanelWindow();
  if (targetPanel && !targetPanel.isDestroyed()) {
    const sendMessages = () => {
      targetPanel.webContents.send(IPC_CHANNELS.SESSION_RESTORE_MESSAGES, messages);
    };
    if (panelIsNew || targetPanel.webContents.isLoading()) {
      targetPanel.webContents.once('did-finish-load', sendMessages);
    } else {
      // Small delay to ensure the session:cleared has been processed
      setTimeout(sendMessages, 50);
    }
  }

  registerHotkeys();
  startInactivityTimer();
}

export async function endCurrentSession(): Promise<void> {
  if (appMode !== 'session') return;

  console.log('[appState] Ending session');
  stopInactivityTimer();
  unregisterHotkeys();

  // If a meeting is still recording or in the ended-with-summary state,
  // tear it down so the mic/system-audio capture stops. Otherwise the
  // SCStream + AEC pipeline keeps running in the background — logs keep
  // firing, CPU is wasted, and the mic stays tapped.
  try {
    const { getMeetingState, endMeeting } = await import('./meeting/index');
    if (getMeetingState() !== 'idle') {
      endMeeting();
    }
  } catch (err) {
    console.warn('[appState] Failed to stop meeting on session end:', err);
  }

  const sessionId = getCurrentSessionId();
  if (sessionId) {
    try {
      const messages = getExportableMessages();
      // Only save messages if there are any. Messages are a no-op for empty.
      if (messages.length > 0) {
        saveAllMessages(sessionId, messages);
      }
      dbEndSession(sessionId, messages.length);
      // Prune the session row if it has no messages AND no meeting attached.
      // ensureSessionExists may not have run (no first message, no meeting)
      // in which case there's no row to prune — deleteSessionIfEmpty is a
      // no-op then.
      const pruned = deleteSessionIfEmpty(sessionId);
      if (!pruned) {
        console.log(`[appState] Session ${sessionId} saved (${messages.length} messages)`);
      }
    } catch (err) {
      console.error('[appState] Failed to save session:', err);
    }
  }

  hideSidePanel();

  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

  showGeneralWindow();

  const general = getGeneralWindow();
  if (general && !general.isDestroyed()) {
    general.webContents.send('session:ended');
    general.webContents.send('history:updated');
  }

  appMode = 'idle';
}

function startInactivityTimer(): void {
  stopInactivityTimer();
  inactivityTimer = setInterval(() => {
    const lastActivity = getLastActivityAt();
    const elapsed = Date.now() - lastActivity;
    if (elapsed >= INACTIVITY_TIMEOUT_MS) {
      console.log('[appState] Session timed out due to inactivity');
      endCurrentSession();
    }
  }, 60_000);
}

function stopInactivityTimer(): void {
  if (inactivityTimer) {
    clearInterval(inactivityTimer);
    inactivityTimer = null;
  }
}
