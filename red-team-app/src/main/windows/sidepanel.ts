import { app, BrowserWindow, screen } from 'electron';
import * as path from 'path';
import { getSettings } from '../settingsStore';

let sidepanelWindow: BrowserWindow | null = null;

// ── Native panel helper (macOS only) ──
// Converts the BrowserWindow's NSWindow into a non-activating floating panel.
let panelHelper: { makePanel: (handle: Buffer) => boolean; setAllowKeyWindow: (allow: boolean, handle?: Buffer) => void } | null = null;

if (process.platform === 'darwin') {
  try {
    // In packaged app: extraResources puts it in Contents/Resources/
    // In dev: it's in build/Release/ relative to project root
    const packaged = path.join(process.resourcesPath, 'panel_helper.node');
    const dev = path.join(__dirname, '..', '..', '..', 'build', 'Release', 'panel_helper.node');
    const fs = require('fs');
    const addonPath = fs.existsSync(packaged) ? packaged : dev;
    panelHelper = require(addonPath);
    console.log('[sidepanel] Native panel helper loaded from', addonPath);
  } catch (err) {
    console.warn('[sidepanel] Native panel helper not available — focus behavior may be degraded:', err);
  }
}

export function createSidePanelWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const settings = getSettings();

  const PANEL_WIDTH = 540;
  const PANEL_HEIGHT = 720;

  sidepanelWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    minWidth: 380,
    minHeight: 480,
    x: Math.round((width - PANEL_WIDTH) / 2),
    y: Math.round((height - PANEL_HEIGHT) / 2),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    focusable: false,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  sidepanelWindow.setAlwaysOnTop(true, 'floating');
  sidepanelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Apply native panel behavior (non-activating + hidden from Mission Control)
  if (panelHelper) {
    try {
      const handle = sidepanelWindow.getNativeWindowHandle();
      const ok = panelHelper.makePanel(handle);
      if (ok) {
        // Native panel handles focus — re-enable focusable so clicks work normally
        sidepanelWindow.setFocusable(true);
        console.log('[sidepanel] Native panel mode active');
      }
    } catch (err) {
      console.warn('[sidepanel] Failed to apply native panel behavior:', err);
    }
  }

  // Apply content protection based on setting
  if (settings.contentProtection !== false) {
    sidepanelWindow.setContentProtection(true);
  }

  sidepanelWindow.loadFile(
    path.join(__dirname, '..', '..', '..', 'src', 'renderer', 'sidepanel', 'index.html'),
  );

  sidepanelWindow.once('ready-to-show', () => {
    sidepanelWindow?.showInactive();
    // Start with click-through enabled so transparent areas don't block clicks
    sidepanelWindow?.setIgnoreMouseEvents(true, { forward: true });
  });

  // Prevent accidental close — hide instead (avoids NSWindow KVO crash on dealloc)
  sidepanelWindow.on('close', (e) => {
    if (sidepanelWindow && !sidepanelWindow.isDestroyed()) {
      e.preventDefault();
      sidepanelWindow.hide();
    }
  });

  return sidepanelWindow;
}

/* ── Focus management for text input ── */

/**
 * Allow the panel to become the key window so the user can type.
 * The native addon makes this work WITHOUT activating the app.
 */
export function enableFocus(): void {
  if (!sidepanelWindow || sidepanelWindow.isDestroyed()) return;

  if (panelHelper) {
    const handle = sidepanelWindow.getNativeWindowHandle();
    panelHelper.setAllowKeyWindow(true, handle);
  } else {
    sidepanelWindow.setFocusable(true);
    sidepanelWindow.focus();
  }
}

/**
 * Disallow the panel from being key — keyboard goes back to the app below.
 */
export function disableFocus(): void {
  if (!sidepanelWindow || sidepanelWindow.isDestroyed()) return;

  if (panelHelper) {
    // Native resignKeyWindow — clean, no hide/flash side effects
    const handle = sidepanelWindow.getNativeWindowHandle();
    panelHelper.setAllowKeyWindow(false, handle);
    // Do NOT call sidepanelWindow.blur() — it triggers Electron's orderBack
    // which causes a brief flash with Transient collection behavior.
  } else {
    sidepanelWindow.setFocusable(false);
    sidepanelWindow.blur();
  }
}

/* ── Visibility helpers ── */

export function showSidePanel(): void {
  if (!sidepanelWindow || sidepanelWindow.isDestroyed()) return;
  sidepanelWindow.showInactive();
}

export function hideSidePanel(): void {
  if (!sidepanelWindow || sidepanelWindow.isDestroyed()) return;
  sidepanelWindow.hide();
}

export function getSidePanelWindow(): BrowserWindow | null {
  return sidepanelWindow;
}

export function destroySidePanelWindow(): void {
  if (sidepanelWindow && !sidepanelWindow.isDestroyed()) {
    // Remove close handler to allow actual destruction
    sidepanelWindow.removeAllListeners('close');
    sidepanelWindow.destroy();
  }
  sidepanelWindow = null;
}

export function updateContentProtection(enabled: boolean): void {
  if (sidepanelWindow && !sidepanelWindow.isDestroyed()) {
    sidepanelWindow.setContentProtection(enabled);
  }
}
