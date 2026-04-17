/**
 * stt.ts — Deepgram real-time speech-to-text via WebSocket.
 *
 * Single multichannel connection: stereo 16-bit PCM @ 16kHz.
 *   Channel 0 (L) = system audio → "Them"
 *   Channel 1 (R) = microphone   → "You"
 *
 * Echo suppression is handled BEFORE audio reaches Deepgram:
 * the mic channel is replaced with silence when system audio has energy.
 *
 * Emits events:
 *   'transcript'   → TranscriptEvent (with channel + speaker)
 *   'utterance'    → fired when speech_final=true
 *   'error'        → connection or processing error
 *   'connected'    → WebSocket connected
 *   'disconnected' → WebSocket closed
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';

// ── Types ──

export interface TranscriptEvent {
  channel: number;        // 0 = system (them), 1 = mic (you)
  speaker: string;        // 'them' or 'you'
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  start: number;
  duration: number;
  confidence: number;
}

// Keep for backward compat
export type RawTranscriptEvent = TranscriptEvent;

interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words: { word: string; start: number; end: number; confidence: number }[];
}

interface DeepgramChannel {
  alternatives: DeepgramAlternative[];
}

interface DeepgramResponse {
  type: string;
  channel_index: number[];
  duration: number;
  start: number;
  is_final: boolean;
  speech_final: boolean;
  channel: DeepgramChannel;
}

// ── Config ──

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

export interface SttConfig {
  apiKey: string;
  language?: string;
  model?: string;
}

// ── STT Client ──

export class SttClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private language: string;
  private model: string;
  private reconnectAttempts = 0;
  private maxReconnects = 5;
  private shouldReconnect = false;
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: SttConfig) {
    super();
    this.apiKey = config.apiKey;
    this.language = config.language || 'en';
    this.model = config.model || 'nova-2';
  }

  /**
   * Connect to Deepgram WebSocket (multichannel stereo).
   */
  connect(): void {
    if (this.ws) {
      console.log('[stt] Already connected');
      return;
    }

    this.shouldReconnect = true;

    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '2',
      multichannel: 'true',
      smart_format: 'true',
      interim_results: 'true',
      // Higher value = fewer false sentence-splits on natural pauses. 2500ms
      // keeps a natural speaker pause from being misread as end-of-utterance.
      utterance_end_ms: '2500',
      endpointing: '500',
      vad_events: 'true',
      punctuate: 'true',
    });

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;
    console.log('[stt] Connecting to Deepgram (multichannel)...');

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.ws.on('open', () => {
      console.log('[stt] Connected to Deepgram');
      this.reconnectAttempts = 0;
      this.emit('connected');
      this.startKeepAlive();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.error('[stt] Failed to parse message:', err);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(`[stt] Disconnected (code=${code}, reason=${reason.toString()})`);
      this.cleanup();
      this.emit('disconnected', code);

      if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnects) {
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
        console.log(`[stt] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error('[stt] WebSocket error:', err.message);
      this.emit('error', err);
    });
  }

  /**
   * Send stereo audio to Deepgram.
   * Expects interleaved stereo 16-bit PCM @ 16kHz (L=system, R=mic).
   */
  sendAudio(chunk: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch {}
      this.ws.close();
      this.cleanup();
    }
    this.emit('disconnected', 1000);
    console.log('[stt] Disconnected (user-initiated)');
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ── Private ──

  private handleMessage(msg: any): void {
    if (msg.type === 'Results') {
      this.handleResults(msg as DeepgramResponse);
    } else if (msg.type === 'UtteranceEnd') {
      this.emit('utterance_end');
    } else if (msg.type === 'SpeechStarted') {
      this.emit('speech_started');
    } else if (msg.type === 'Metadata') {
      console.log('[stt] Model:', msg.model_info?.name || 'unknown');
    }
  }

  private handleResults(msg: DeepgramResponse): void {
    const channelIndex = msg.channel_index?.[0] ?? 0;
    const alt = msg.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;

    const text = alt.transcript.trim();
    if (!text) return;

    // Channel 0 = system audio = "them", Channel 1 = mic = "you"
    const speaker = channelIndex === 1 ? 'you' : 'them';

    const event: TranscriptEvent = {
      channel: channelIndex,
      speaker,
      text,
      isFinal: msg.is_final,
      speechFinal: msg.speech_final,
      start: msg.start,
      duration: msg.duration,
      confidence: alt.confidence,
    };

    this.emit('transcript', event);

    if (msg.speech_final && msg.is_final) {
      this.emit('utterance', event);
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 8000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  private cleanup(): void {
    this.stopKeepAlive();
    this.ws = null;
  }
}
