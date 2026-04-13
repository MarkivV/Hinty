import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { createGeneralWindow, getGeneralWindow, updateGeneralContentProtection } from './windows/general';
import { getSidePanelWindow, enableFocus, disableFocus, updateContentProtection, destroySidePanelWindow } from './windows/sidepanel';
import { initCapture } from './capture/index';
import { captureScreenshot } from './capture/screenshot';
import { getSettings, updateSettings } from './settingsStore';
import { sendMessage } from './session';
import { fireTrigger } from './hotkeys';
import { initDb, startSession, endCurrentSession, continueExistingSession, getAppMode } from './appState';
import { closeConnection } from './db/connection';
import { getRecentSessions, getSessionMessages, deleteSession, wipeLocalCache, syncSessionList } from './db/repository';
import { IPC_CHANNELS } from '../shared/types';
import { login, register, logout, getAuthState, refreshProfile, isAuthenticated, stopCallbackServer, openUpgradeCheckout, openBillingPortal, handleDeepLink } from './auth/authClient';
import { getStoredUser } from './auth/tokenStore';
import { checkForUpdates, downloadUpdate, installUpdate, getUpdateState } from './updater';
import { startFocusTimer, pauseTimer, resumeTimer, endTimer, skipBreak, getTimerState } from './focusTimer';

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

  // Content protection toggle
  ipcMain.on('settings:toggle-content-protection', (_event, enabled: boolean) => {
    updateSettings({ contentProtection: enabled });
    updateContentProtection(enabled);
    updateGeneralContentProtection(enabled);
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
  ipcMain.on('stripe:upgrade', () => { openUpgradeCheckout(); });
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
app.on('before-quit', (event) => {
  stopCallbackServer();
  if (getAppMode() === 'session') {
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
