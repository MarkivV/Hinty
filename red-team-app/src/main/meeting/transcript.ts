/**
 * transcript.ts — Manages the running transcript buffer for a meeting.
 *
 * Accumulates transcript entries from STT, handles deduplication
 * of interim vs final results, and provides the debounce logic
 * that triggers AI processing at natural speech pauses.
 *
 * Emits:
 *   'entry'    → new finalized transcript entry added
 *   'trigger'  → debounce expired — time to send to AI for analysis
 */

import { EventEmitter } from 'events';
import { nanoid } from 'nanoid';
import { TranscriptEntry } from '../../shared/types';
import { TranscriptEvent } from './stt';

// ── Config ──
const DEBOUNCE_MS = 1500; // 1.5s silence after speech_final → trigger AI

export class TranscriptBuffer extends EventEmitter {
  private entries: TranscriptEntry[] = [];
  private meetingId: string;
  private meetingStartTime: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Track interim text per channel to avoid duplicates
  private interimText: Map<number, string> = new Map();

  // Track which entries have been sent to AI (for incremental context)
  private lastAiIndex = 0;

  constructor(meetingId: string) {
    super();
    this.meetingId = meetingId;
    this.meetingStartTime = Date.now();
  }

  /**
   * Process a transcript event from STT.
   * Only final results are stored; interim results are tracked for dedup.
   *
   * Channel separation is trusted: L (channel 0) = system = "Them",
   * R (channel 1) = mic = "You". Echo removal happens in the audio layer
   * (VoiceProcessingIO AEC in src/native/audio_capture.mm), not here.
   */
  addEvent(event: TranscriptEvent): void {
    if (!event.isFinal) {
      // Track interim text for live display (not stored)
      this.interimText.set(event.channel, event.text);
      return;
    }

    // Clear interim for this channel
    this.interimText.delete(event.channel);

    // Create transcript entry
    const entry: TranscriptEntry = {
      id: nanoid(),
      meetingId: this.meetingId,
      timestamp: Math.round((Date.now() - this.meetingStartTime) / 1000),
      speaker: event.speaker,
      text: event.text,
      channel: event.channel as 0 | 1,
    };

    this.entries.push(entry);
    this.emit('entry', entry);

    // If this is a speech_final event, start the debounce timer
    if (event.speechFinal) {
      this.startDebounce();
    }
  }

  /**
   * Get all transcript entries.
   */
  getAll(): TranscriptEntry[] {
    return [...this.entries];
  }

  /**
   * Get entries since last AI trigger (for incremental context).
   */
  getNewSinceLastTrigger(): TranscriptEntry[] {
    const newEntries = this.entries.slice(this.lastAiIndex);
    return newEntries;
  }

  /**
   * Mark current position as sent to AI.
   */
  markAiProcessed(): void {
    this.lastAiIndex = this.entries.length;
  }

  /**
   * Get the full transcript as formatted text.
   */
  getFormattedText(): string {
    return this.entries.map(e => {
      const mins = Math.floor(e.timestamp / 60);
      const secs = e.timestamp % 60;
      const time = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      const speaker = e.speaker === 'you' ? 'You' : 'Them';
      return `[${time}] ${speaker}: ${e.text}`;
    }).join('\n');
  }

  /**
   * Get recent transcript text (last N seconds) for AI context.
   */
  getRecentText(lastSeconds: number): string {
    if (this.entries.length === 0) return '';

    const now = Math.round((Date.now() - this.meetingStartTime) / 1000);
    const cutoff = now - lastSeconds;

    return this.entries
      .filter(e => e.timestamp >= cutoff)
      .map(e => {
        const speaker = e.speaker === 'you' ? 'You' : 'Them';
        return `${speaker}: ${e.text}`;
      })
      .join('\n');
  }

  /**
   * Get current interim text for live display.
   */
  getInterimText(): { channel: number; text: string }[] {
    const result: { channel: number; text: string }[] = [];
    this.interimText.forEach((text, channel) => {
      result.push({ channel, text });
    });
    return result;
  }

  /**
   * Get total number of entries.
   */
  get length(): number {
    return this.entries.length;
  }

  /**
   * Get meeting duration in seconds.
   */
  getDuration(): number {
    return Math.round((Date.now() - this.meetingStartTime) / 1000);
  }

  /**
   * Clear everything.
   */
  clear(): void {
    this.entries = [];
    this.interimText.clear();
    this.lastAiIndex = 0;
    this.cancelDebounce();
  }

  /**
   * Cancel any pending debounce.
   */
  cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ── Private ──

  private startDebounce(): void {
    // Reset timer — we want 1.5s of silence after the LAST speech_final
    this.cancelDebounce();

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;

      // Only trigger if there are new entries since last AI processing
      const newEntries = this.getNewSinceLastTrigger();
      if (newEntries.length > 0) {
        this.emit('trigger', newEntries);
      }
    }, DEBOUNCE_MS);
  }
}
