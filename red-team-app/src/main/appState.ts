import { app } from 'electron';
import { AppMode } from '../shared/types';
import { createSidePanelWindow, getSidePanelWindow, hideSidePanel, showSidePanel } from './windows/sidepanel';
import { showGeneralWindow, hideGeneralWindow, getGeneralWindow } from './windows/general';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { resetSession, restoreSession, getCurrentSessionId, getExportableMessages, getLastActivityAt, RestoredMessage } from './session';
import { getSettings, AI_MODEL } from './settingsStore';
import { initDatabase } from './db/schema';
import { createSession, endSession as dbEndSession, saveAllMessages, reopenSession, getSessionMessages } from './db/repository';
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
    console.log('[appState] SQLite initialized');
  } catch (err) {
    console.error('[appState] Failed to initialize SQLite:', err);
  }
}

export async function startSession(): Promise<void> {
  if (appMode === 'session') return;

  appMode = 'session';
  console.log('[appState] Starting session');

  const sessionId = resetSession();
  const user = getStoredUser();

  if (user?.id) {
    try {
      createSession(sessionId, AI_MODEL, String(user.id));
    } catch (err) {
      console.error('[appState] Failed to create session in DB:', err);
    }
  }

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

  const sessionId = getCurrentSessionId();
  if (sessionId) {
    try {
      const messages = getExportableMessages();
      saveAllMessages(sessionId, messages);
      dbEndSession(sessionId, messages.length);
      console.log(`[appState] Session ${sessionId} saved (${messages.length} messages)`);
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
