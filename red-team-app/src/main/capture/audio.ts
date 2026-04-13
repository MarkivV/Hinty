import { ipcMain } from 'electron';

let latestTranscript = '';

export function initAudioCapture(): void {
  // The overlay renderer runs Web Speech API and sends transcripts back via IPC
  ipcMain.on('audio:transcript-update', (_event, transcript: string) => {
    latestTranscript = transcript;
  });

  // Audio capture disabled for now — Web Speech API in Electron produces
  // noisy errors (chunked_data_pipe). Will be re-enabled in a later phase.
  // const overlay = getOverlayWindow();
  // if (overlay && !overlay.isDestroyed()) {
  //   overlay.webContents.send('audio:start');
  // }

  console.log('[audio] IPC listener registered (speech recognition disabled for now)');
}

export function getAudioTranscript(): string {
  console.log(`[audio] ${latestTranscript.length} chars`);
  return latestTranscript;
}
