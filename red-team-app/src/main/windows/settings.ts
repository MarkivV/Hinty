import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

let settingsWindow: BrowserWindow | null = null;

export function createSettingsWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const WIN_WIDTH = 480;
  const WIN_HEIGHT = 560;

  settingsWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: Math.round((width - WIN_WIDTH) / 2),
    y: Math.round((height - WIN_HEIGHT) / 2),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.setAlwaysOnTop(true, 'screen-saver');
  settingsWindow.setContentProtection(true);

  settingsWindow.loadFile(
    path.join(__dirname, '..', '..', '..', 'src', 'renderer', 'settings', 'index.html'),
  );

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

export function showSettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  settingsWindow.show();
}

export function hideSettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  settingsWindow.hide();
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}

export function destroySettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
  settingsWindow = null;
}
