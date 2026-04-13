import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app } from 'electron';
import { getGeneralWindow } from './windows/general';

// Auto-download updates and install on quit
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let updateAvailable = false;
let updateInfo: UpdateInfo | null = null;
let downloadProgress = 0;
let isDownloading = false;

function notifyRenderer(channel: string, data?: unknown) {
  const win = getGeneralWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

// ── Events ──

autoUpdater.on('checking-for-update', () => {
  console.log('[updater] Checking for update...');
});

autoUpdater.on('update-available', (info: UpdateInfo) => {
  const currentVersion = app.getVersion();
  console.log(`[updater] Update available: ${info.version} (current: ${currentVersion})`);

  // Don't show update banner if versions match (false positive from re-uploaded release)
  if (info.version === currentVersion) {
    console.log('[updater] Same version — ignoring');
    notifyRenderer('updater:up-to-date');
    return;
  }

  updateAvailable = true;
  updateInfo = info;
  notifyRenderer('updater:update-available', {
    version: info.version,
    releaseNotes: info.releaseNotes,
  });
});

autoUpdater.on('update-not-available', () => {
  console.log('[updater] App is up to date');
  notifyRenderer('updater:up-to-date');
});

autoUpdater.on('download-progress', (progress) => {
  downloadProgress = Math.round(progress.percent);
  notifyRenderer('updater:download-progress', { percent: downloadProgress });
});

autoUpdater.on('update-downloaded', () => {
  console.log('[updater] Update downloaded — restarting to install');
  isDownloading = false;
  notifyRenderer('updater:ready-to-install', {
    version: updateInfo?.version,
  });
  // Restart immediately to apply the update
  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true);
  }, 1500); // Brief delay so the user sees the "Restarting..." message
});

autoUpdater.on('error', (err) => {
  console.error('[updater] Error:', err.message);
  isDownloading = false;
  notifyRenderer('updater:error', { message: err.message });
});

// ── Public API ──

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[updater] Check failed:', err.message);
  });
}

export function downloadUpdate(): void {
  if (!updateAvailable || isDownloading) return;
  isDownloading = true;
  downloadProgress = 0;
  autoUpdater.downloadUpdate().catch((err) => {
    console.error('[updater] Download failed:', err.message);
    isDownloading = false;
  });
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true);
}

export function getUpdateState() {
  return {
    updateAvailable,
    version: updateInfo?.version || null,
    isDownloading,
    downloadProgress,
  };
}
