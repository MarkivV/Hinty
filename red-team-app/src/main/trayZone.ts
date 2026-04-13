import { BrowserWindow, screen, ipcMain } from 'electron';
import * as path from 'path';
import { fireTrigger } from './hotkeys';

let trayZoneWindow: BrowserWindow | null = null;

export function createTrayZoneWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const ZONE_SIZE = 20;

  trayZoneWindow = new BrowserWindow({
    width: ZONE_SIZE,
    height: ZONE_SIZE,
    x: width - ZONE_SIZE,
    y: height - ZONE_SIZE,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  trayZoneWindow.setAlwaysOnTop(true, 'screen-saver');
  trayZoneWindow.setContentProtection(true);
  trayZoneWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  trayZoneWindow.loadFile(
    path.join(__dirname, '..', '..', 'src', 'renderer', 'trayzone', 'index.html'),
  );

  trayZoneWindow.once('ready-to-show', () => {
    trayZoneWindow?.show();
  });

  trayZoneWindow.on('closed', () => {
    trayZoneWindow = null;
  });

  return trayZoneWindow;
}

export function getTrayZoneWindow(): BrowserWindow | null {
  return trayZoneWindow;
}

export function destroyTrayZoneWindow(): void {
  if (trayZoneWindow && !trayZoneWindow.isDestroyed()) {
    trayZoneWindow.close();
  }
  trayZoneWindow = null;
}

// Listen for click events from the tray zone renderer
ipcMain.on('trayzone:clicked', () => {
  fireTrigger();
});
