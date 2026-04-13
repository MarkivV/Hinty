import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import { getSettings } from '../settingsStore';

let generalWindow: BrowserWindow | null = null;

export function createGeneralWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const WIN_WIDTH = 1080;
  const WIN_HEIGHT = 720;

  generalWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: 900,
    minHeight: 600,
    x: Math.round((width - WIN_WIDTH) / 2),
    y: Math.round((height - WIN_HEIGHT) / 2),
    transparent: false,
    backgroundColor: '#0a0a0b',
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    alwaysOnTop: false,
    skipTaskbar: false,
    hasShadow: true,
    resizable: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const settings = getSettings();
  if (settings.contentProtection !== false) {
    generalWindow.setContentProtection(true);
  }

  const htmlPath = path.join(__dirname, '..', '..', '..', 'src', 'renderer', 'general', 'index.html');

  generalWindow.loadFile(htmlPath);

  generalWindow.once('ready-to-show', () => {
    generalWindow?.show();
  });

  generalWindow.on('closed', () => {
    generalWindow = null;
  });

  return generalWindow;
}

export function getGeneralWindow(): BrowserWindow | null {
  return generalWindow;
}

export function showGeneralWindow(): void {
  if (generalWindow && !generalWindow.isDestroyed()) {
    generalWindow.show();
    generalWindow.focus();
  }
}

export function hideGeneralWindow(): void {
  if (generalWindow && !generalWindow.isDestroyed()) {
    generalWindow.hide();
  }
}

export function updateGeneralContentProtection(enabled: boolean): void {
  if (generalWindow && !generalWindow.isDestroyed()) {
    generalWindow.setContentProtection(enabled);
  }
}
