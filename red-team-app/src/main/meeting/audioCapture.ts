/**
 * audioCapture.ts — Node.js wrapper for the native audio_capture addon.
 *
 * Captures system audio (ScreenCaptureKit) + microphone (AVAudioEngine)
 * and emits stereo 16-bit PCM chunks at 16kHz via an EventEmitter.
 *
 * Left channel  = system audio (other meeting participants)
 * Right channel = microphone (you)
 */

import { EventEmitter } from 'events';
import * as path from 'path';

// ── Load native addon ──
interface AudioCaptureAddon {
  checkPermission(): 'granted' | 'denied' | 'unknown' | 'unsupported';
  requestPermission(): Promise<boolean>;
  startCapture(callback: (chunk: Buffer) => void): boolean;
  stopCapture(): void;
  isCapturing(): boolean;
}

let addon: AudioCaptureAddon | null = null;

function loadAddon(): AudioCaptureAddon {
  if (addon) return addon;

  try {
    // In dev: build/Release/audio_capture.node
    // In prod: same relative path from dist/main/meeting/
    const addonPath = path.join(__dirname, '..', '..', '..', 'build', 'Release', 'audio_capture.node');
    addon = require(addonPath) as AudioCaptureAddon;
    console.log('[audioCapture] Native addon loaded');
    return addon;
  } catch (err) {
    console.error('[audioCapture] Failed to load native addon:', err);
    throw new Error('Audio capture is not available on this system');
  }
}

// ── AudioCapture class ──

export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'unsupported';

class AudioCapture extends EventEmitter {
  private _capturing = false;

  /**
   * Check if screen recording + microphone permissions are granted.
   */
  checkPermission(): PermissionStatus {
    try {
      const native = loadAddon();
      return native.checkPermission();
    } catch {
      return 'unsupported';
    }
  }

  /**
   * Request screen recording + microphone permissions.
   * Returns true if screen recording was granted (mic is async dialog).
   */
  async requestPermission(): Promise<boolean> {
    const native = loadAddon();
    return native.requestPermission();
  }

  /**
   * Start capturing system audio + microphone.
   * Emits 'chunk' events with Buffer containing stereo 16-bit PCM at 16kHz.
   * Emits 'error' on failure.
   */
  start(): boolean {
    if (this._capturing) {
      console.log('[audioCapture] Already capturing');
      return false;
    }

    try {
      const native = loadAddon();

      const ok = native.startCapture((chunk: Buffer) => {
        this.emit('chunk', chunk);
      });

      if (ok) {
        this._capturing = true;
        this.emit('started');
        console.log('[audioCapture] Capture started');
      }

      return ok;
    } catch (err) {
      console.error('[audioCapture] Start failed:', err);
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Stop capturing.
   */
  stop(): void {
    if (!this._capturing) return;

    try {
      const native = loadAddon();
      native.stopCapture();
    } catch (err) {
      console.error('[audioCapture] Stop error:', err);
    }

    this._capturing = false;
    this.emit('stopped');
    console.log('[audioCapture] Capture stopped');
  }

  /**
   * Check if currently capturing.
   */
  isCapturing(): boolean {
    return this._capturing;
  }
}

// Singleton
export const audioCapture = new AudioCapture();
