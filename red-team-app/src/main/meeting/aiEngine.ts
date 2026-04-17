/**
 * aiEngine.ts — Two-channel AI system for Meeting Copilot.
 *
 * Channel 1 (AUTO): Event-driven suggestions based on transcript.
 *   - Triggered by TranscriptBuffer 'trigger' event (speech pause + debounce)
 *   - Classifies if AI should speak or stay silent
 *   - Lower priority — cancelled if user sends a message
 *
 * Channel 2 (USER): User's manual messages during the meeting.
 *   - Triggered by user clicking send / template buttons
 *   - Cancels any running Channel 1 request
 *   - Highest priority — disables controls while processing
 *
 * Both channels receive: transcript + documents + meeting context
 */

import { EventEmitter } from 'events';
import { streamCompletion } from '../ai/stream';
import { AI_MODEL } from '../settingsStore';
import { TranscriptEntry, MeetingDocument, MeetingActionItem } from '../../shared/types';
import { buildDocumentContext } from './documents';

// ── Types ──

export interface Suggestion {
  id: string;
  type: 'suggestion' | 'action_item' | 'warning' | 'silent';
  content: string;
  timestamp: number;
}

export interface UserResponse {
  content: string;
}

// ── System prompts ──

const AUTO_SYSTEM_PROMPT = `You are a real-time meeting assistant running invisibly on the user's screen. You monitor the live conversation transcript and proactively help the user.

YOUR RULES:
1. Speak whenever you can add value:
   - Someone asks the user a question → suggest a concise answer (reference uploaded documents if relevant)
   - Someone mentions a number, date, or claim → cross-reference with uploaded documents, flag discrepancies
   - A commitment or action item is made → flag it with [ACTION] prefix
   - Someone states incorrect information → warn with [WARNING] prefix
   - The user could benefit from specific data from the uploaded documents → surface it
   - A key point, decision, or important detail is being discussed → briefly highlight it
   - The user is presenting or explaining something → suggest improvements, talking points, or things they might be forgetting
   - A complex topic comes up → offer a brief clarification or summary

2. Stay SILENT ONLY when:
   - Brief small talk or pleasantries with nothing substantive
   - You already suggested something about this exact topic and nothing new has been added
   - The last few seconds of speech were just filler words or incomplete thoughts

3. When you have nothing useful to add, respond with exactly: [SILENT]

4. Keep suggestions SHORT (1-3 sentences). The user is reading while talking.

5. Format action items as: [ACTION] Task description — Owner

6. Format warnings as: [WARNING] Brief explanation

7. Never repeat a suggestion you already made.

IMPORTANT: Err on the side of being helpful. If in doubt, provide a brief insight rather than staying silent.`;

const USER_SYSTEM_PROMPT = `You are a real-time meeting assistant. The user is currently in a meeting and asking you a question. You have access to:
- The live meeting transcript (what everyone has said)
- Documents the user uploaded before the meeting
- The meeting context/goal

Be concise and direct — the user is reading your response while participating in the meeting. Use bullet points and short paragraphs. If the user asks about something from the documents, quote the relevant parts.`;

// ── AI Engine ──

export class MeetingAiEngine extends EventEmitter {
  private autoAbort: AbortController | null = null;
  private userAbort: AbortController | null = null;
  private isAutoRunning = false;
  private isUserRunning = false;
  private previousSuggestions: string[] = []; // track to avoid repeats
  private actionItems: MeetingActionItem[] = [];

  /**
   * Process new transcript entries (Channel 1 — auto-suggestions).
   * Called by the transcript buffer's 'trigger' event.
   */
  async processTranscript(
    newEntries: TranscriptEntry[],
    fullTranscript: string,
    documents: MeetingDocument[],
    meetingContext: string,
  ): Promise<void> {
    // Don't run if user request is in progress
    if (this.isUserRunning) {
      console.log('[aiEngine] Skipping auto — user request in progress');
      return;
    }

    // Don't stack auto requests
    if (this.isAutoRunning) {
      this.cancelAuto();
    }

    this.isAutoRunning = true;
    this.autoAbort = new AbortController();

    const recentTranscript = newEntries
      .map(e => {
        const speaker = e.speaker === 'you' ? 'You' : 'Them';
        return `${speaker}: ${e.text}`;
      })
      .join('\n');

    const docContext = buildDocumentContext(documents);
    const prevSuggestions = this.previousSuggestions.length > 0
      ? '\n\nYour previous suggestions (DO NOT repeat these):\n' + this.previousSuggestions.slice(-5).join('\n')
      : '';

    const messages = [
      { role: 'system', content: AUTO_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          meetingContext ? `MEETING CONTEXT: ${meetingContext}` : '',
          docContext ? `UPLOADED DOCUMENTS:\n${docContext}` : '',
          `FULL TRANSCRIPT SO FAR:\n${fullTranscript}`,
          `NEW (just said):\n${recentTranscript}`,
          prevSuggestions,
          '\nBased on what was JUST said, should you help? Respond with your suggestion or [SILENT].',
        ].filter(Boolean).join('\n\n'),
      },
    ];

    try {
      let response = '';
      await streamCompletion({
        messages,
        model: AI_MODEL,
        temperature: 0.4,
        maxTokens: 300,
        onToken: (token) => {
          response += token;
          // Stream auto-suggestion tokens to renderer for live display
          this.emit('auto:token', token);
        },
        signal: this.autoAbort.signal,
      });

      response = response.trim();

      // Parse response
      if (response === '[SILENT]' || response.includes('[SILENT]')) {
        this.emit('auto:silent');
        console.log('[aiEngine] Auto: SILENT');
      } else {
        // Track this suggestion to avoid repeats
        this.previousSuggestions.push(response.slice(0, 100));

        // Extract action items
        const actionLines = response.split('\n').filter(l => l.includes('[ACTION]'));
        for (const line of actionLines) {
          const cleaned = line.replace('[ACTION]', '').trim();
          const parts = cleaned.split('—').map(s => s.trim());
          const item: MeetingActionItem = {
            id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            task: parts[0] || cleaned,
            owner: parts[1] || 'unassigned',
            done: false,
          };
          this.actionItems.push(item);
          this.emit('action_item', item);
        }

        // Determine suggestion type
        let type: Suggestion['type'] = 'suggestion';
        if (response.includes('[WARNING]')) type = 'warning';
        else if (response.includes('[ACTION]')) type = 'action_item';

        const suggestion: Suggestion = {
          id: `sug_${Date.now()}`,
          type,
          content: response.replace(/\[ACTION\]\s*/g, '').replace(/\[WARNING\]\s*/g, ''),
          timestamp: Date.now(),
        };

        this.emit('auto:suggestion', suggestion);
        console.log(`[aiEngine] Auto: ${type} (${response.length} chars)`);
      }

      this.emit('auto:done');
    } catch (err: any) {
      if (this.autoAbort?.signal.aborted) {
        console.log('[aiEngine] Auto: cancelled');
      } else {
        console.error('[aiEngine] Auto error:', err.message);
        this.emit('auto:error', err.message);
      }
    } finally {
      this.isAutoRunning = false;
      this.autoAbort = null;
    }
  }

  /**
   * Process a user message (Channel 2 — priority).
   * Cancels any running auto-suggestion.
   */
  async processUserMessage(
    userText: string,
    fullTranscript: string,
    documents: MeetingDocument[],
    meetingContext: string,
    screenshot?: string | null,
  ): Promise<string> {
    // Cancel auto-suggestion if running
    this.cancelAuto();

    this.isUserRunning = true;
    this.userAbort = new AbortController();

    const docContext = buildDocumentContext(documents);

    const userContent: any[] = [];

    // Add screenshot if provided
    if (screenshot) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${screenshot}`, detail: 'high' },
      });
    }

    userContent.push({
      type: 'text',
      text: [
        meetingContext ? `MEETING CONTEXT: ${meetingContext}` : '',
        docContext ? `UPLOADED DOCUMENTS:\n${docContext}` : '',
        `MEETING TRANSCRIPT:\n${fullTranscript}`,
        `\nUSER'S QUESTION: ${userText}`,
      ].filter(Boolean).join('\n\n'),
    });

    const messages = [
      { role: 'system', content: USER_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];

    try {
      this.emit('user:thinking');

      let response = '';
      await streamCompletion({
        messages,
        model: AI_MODEL,
        temperature: 0.3,
        maxTokens: 1024,
        onToken: (token) => {
          response += token;
          this.emit('user:token', token);
        },
        signal: this.userAbort.signal,
      });

      this.emit('user:done', response);
      console.log(`[aiEngine] User response: ${response.length} chars`);
      return response;
    } catch (err: any) {
      if (this.userAbort?.signal.aborted) {
        console.log('[aiEngine] User request: cancelled');
        this.emit('user:cancelled');
        return '';
      }
      console.error('[aiEngine] User error:', err.message);
      this.emit('user:error', err.message);
      throw err;
    } finally {
      this.isUserRunning = false;
      this.userAbort = null;
    }
  }

  /**
   * Cancel the auto-suggestion request (Channel 1).
   */
  cancelAuto(): void {
    if (this.autoAbort) {
      this.autoAbort.abort();
      this.autoAbort = null;
      this.isAutoRunning = false;
    }
  }

  /**
   * Cancel the user request (stop generating).
   */
  cancelUser(): void {
    if (this.userAbort) {
      this.userAbort.abort();
      this.userAbort = null;
      this.isUserRunning = false;
    }
  }

  /**
   * Get all detected action items.
   */
  getActionItems(): MeetingActionItem[] {
    return [...this.actionItems];
  }

  /**
   * Toggle an action item's done status.
   */
  toggleActionItem(id: string): void {
    const item = this.actionItems.find(i => i.id === id);
    if (item) {
      item.done = !item.done;
      this.emit('action_item_updated', item);
    }
  }

  /**
   * Check if user channel is active (controls should be disabled).
   */
  isUserActive(): boolean {
    return this.isUserRunning;
  }

  /**
   * Check if auto channel is active.
   */
  isAutoActive(): boolean {
    return this.isAutoRunning;
  }

  /**
   * Reset state for a new meeting.
   */
  reset(): void {
    this.cancelAuto();
    this.cancelUser();
    this.previousSuggestions = [];
    this.actionItems = [];
    this.removeAllListeners();
  }
}
