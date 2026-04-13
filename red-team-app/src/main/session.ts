import OpenAI from 'openai';
import { nanoid } from 'nanoid';
import { captureScreenshot } from './capture/screenshot';
import { getSettings, AI_MODEL } from './settingsStore';
import { getSidePanelWindow } from './windows/sidepanel';
import { IPC_CHANNELS } from '../shared/types';
import { updateSessionTitle } from './db/repository';
import { getToken } from './auth/tokenStore';

const API_BASE = 'https://hinty-web.vercel.app';

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAI.ChatCompletionContentPart[];
}

export interface SessionMessage {
  role: string;
  text: string;
  screenshot?: string | null;
}

let conversationHistory: Message[] = [];
let screenshotHistory: (string | null)[] = [];
let isProcessing = false;
let currentSessionId: string | null = null;
let lastActivityAt: number = 0;
let titleGenerated = false;

// Limit how many past screenshots are sent to the API to prevent payload bloat.
// Only the most recent N exchanges include their screenshots; older ones are text-only.
const MAX_SCREENSHOTS_IN_CONTEXT = 3;

const SYSTEM_PROMPT = `You are a helpful AI assistant. You can see screenshots of the user's screen that are automatically attached to each message. Analyze what's on screen and help the user with any questions — whether about exams, homework, code, or anything else. Be concise and direct.

Formatting rules:
- Use Markdown for all responses (headers, bold, lists, code blocks with language tags)
- Always render mathematical expressions in LaTeX: use $...$ for inline math and $$...$$ for display/block math
- Never write math in plain text — always wrap in LaTeX delimiters (e.g. $x^2 + 3x + 1 = 0$, not x^2 + 3x + 1 = 0)
- For code, always use fenced code blocks with the language specified (e.g. \`\`\`python)`;

export function resetSession(): string {
  conversationHistory = [];
  screenshotHistory = [];
  isProcessing = false;
  titleGenerated = false;
  currentSessionId = nanoid();
  lastActivityAt = Date.now();
  console.log('[session] New session:', currentSessionId);
  return currentSessionId;
}

export interface RestoredMessage {
  role: string;
  content_text: string | null;
  screenshot: string | null;
}

export function restoreSession(
  sessionId: string,
  messages: RestoredMessage[],
): void {
  conversationHistory = [];
  screenshotHistory = [];
  isProcessing = false;
  titleGenerated = true; // already has a title — don't regenerate
  currentSessionId = sessionId;
  lastActivityAt = Date.now();

  // Rebuild conversation history from stored messages
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.content_text || '';
      if (m.screenshot) {
        screenshotHistory.push(m.screenshot);
        const userContent: OpenAI.ChatCompletionContentPart[] = [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${m.screenshot}`, detail: 'high' } },
          { type: 'text', text },
        ];
        conversationHistory.push({ role: 'user', content: userContent });
      } else {
        screenshotHistory.push(null);
        conversationHistory.push({ role: 'user', content: text });
      }
    } else if (m.role === 'assistant') {
      conversationHistory.push({ role: 'assistant', content: m.content_text || '' });
    }
  }

  console.log(`[session] Restored session ${sessionId} with ${conversationHistory.length} messages`);
}

export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

export function getIsProcessing(): boolean {
  return isProcessing;
}

export function getLastActivityAt(): number {
  return lastActivityAt;
}

export function getExportableMessages(): SessionMessage[] {
  const result: SessionMessage[] = [];
  let screenshotIdx = 0;

  for (const m of conversationHistory) {
    if (m.role === 'user') {
      let text = '';
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === 'object' && 'type' in part && part.type === 'text') {
            text = part.text;
          }
        }
      } else {
        text = m.content;
      }
      result.push({
        role: 'user',
        text,
        screenshot: screenshotHistory[screenshotIdx] || null,
      });
      screenshotIdx++;
    } else if (m.role === 'assistant') {
      result.push({ role: 'assistant', text: m.content as string });
    }
  }

  return result;
}

// Stream response via backend proxy
async function streamViaProxy(
  messages: OpenAI.ChatCompletionMessageParam[],
  model: string,
  onToken: (token: string) => void,
): Promise<string> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated — please sign in');

  const payload = JSON.stringify({
    messages,
    model,
    temperature: 0.3,
    max_tokens: 2048,
  });
  console.log(`[session] Calling ${API_BASE}/api/ai/chat (${(payload.length / 1024).toFixed(1)}KB, model=${model})`);

  const response = await fetch(`${API_BASE}/api/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: payload,
  });

  console.log(`[session] Response status: ${response.status}`);

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `Server error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream');

  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.token) {
          fullResponse += parsed.token;
          onToken(parsed.token);
        }
      } catch (e: any) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    }
  }

  return fullResponse;
}

export async function sendMessage(userText: string, hotkeyTrigger = false): Promise<void> {
  console.log(`[session] sendMessage called: "${userText.substring(0, 50)}..." hotkey=${hotkeyTrigger}`);

  if (isProcessing) {
    console.log('[session] Already processing, ignoring');
    return;
  }

  const panel = getSidePanelWindow();
  const settings = getSettings();

  if (!panel || panel.isDestroyed()) {
    console.log('[session] No panel window, aborting');
    return;
  }

  if (!getToken()) {
    console.log('[session] No auth token');
    panel.webContents.send(IPC_CHANNELS.AI_ERROR, 'Please sign in to use Hinty');
    return;
  }

  isProcessing = true;
  lastActivityAt = Date.now();

  try {
    // Take a fresh screenshot
    const screenshot = await captureScreenshot();
    const base64 = screenshot.toString('base64');

    // Store screenshot and send to renderer
    screenshotHistory.push(base64);
    panel.webContents.send(IPC_CHANNELS.SESSION_SCREENSHOT, base64);

    // Build user message with screenshot (always vision)
    const userContent: OpenAI.ChatCompletionContentPart[] = [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
      { type: 'text', text: userText },
    ];

    conversationHistory.push({ role: 'user', content: userContent });

    // Build messages for the API. Strip screenshots from older exchanges to
    // keep the payload size manageable (each base64 screenshot is ~150-300KB).
    // Only the most recent MAX_SCREENSHOTS_IN_CONTEXT user messages keep their images.
    const userMsgCount = conversationHistory.filter(m => m.role === 'user').length;
    const screenshotCutoff = Math.max(0, userMsgCount - MAX_SCREENSHOTS_IN_CONTEXT);
    let userIdx = 0;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory.map((m): OpenAI.ChatCompletionMessageParam => {
        if (m.role === 'user') {
          const idx = userIdx++;
          if (idx < screenshotCutoff && Array.isArray(m.content)) {
            // Strip image from old messages — keep only the text part
            const textPart = m.content.find(
              (p): p is OpenAI.ChatCompletionContentPartText =>
                typeof p === 'object' && 'type' in p && p.type === 'text'
            );
            return { role: 'user', content: textPart?.text || '[screenshot analyzed]' };
          }
          return { role: 'user', content: m.content as OpenAI.ChatCompletionContentPart[] };
        }
        return { role: 'assistant', content: m.content as string };
      }),
    ];

    console.log(`[session] Sending message (${conversationHistory.length} msgs)`);

    const onToken = (token: string) => {
      if (!panel.isDestroyed()) {
        panel.webContents.send(IPC_CHANNELS.SIDEPANEL_STREAM_TOKEN, token);
      }
    };

    const fullResponse = await streamViaProxy(messages, AI_MODEL, onToken);

    conversationHistory.push({ role: 'assistant', content: fullResponse });

    if (!panel.isDestroyed()) {
      panel.webContents.send(IPC_CHANNELS.AI_RESPONSE_COMPLETE);
    }

    lastActivityAt = Date.now();
    console.log(`[session] Response complete (${fullResponse.length} chars)`);

    // Generate session title after first exchange (fire-and-forget)
    if (!titleGenerated && currentSessionId) {
      titleGenerated = true;
      generateSessionTitle(userText, fullResponse, currentSessionId);
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[session] Error:', msg);
    if (!panel.isDestroyed()) {
      panel.webContents.send(IPC_CHANNELS.AI_ERROR, msg);
    }
  } finally {
    isProcessing = false;
  }
}

async function generateSessionTitle(
  userText: string,
  aiResponse: string,
  sessionId: string,
): Promise<void> {
  try {
    const token = getToken();
    if (!token) return;

    const response = await fetch(`${API_BASE}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'Generate a short title (3-6 words max) for this conversation. Return ONLY the title, nothing else. No quotes.',
          },
          {
            role: 'user',
            content: `User: ${userText.slice(0, 200)}\n\nAssistant: ${aiResponse.slice(0, 300)}`,
          },
        ],
        model: 'gpt-4o-mini',
        temperature: 0.5,
        max_tokens: 20,
      }),
    });

    if (!response.ok) return;

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let title = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.token) title += parsed.token;
        } catch {}
      }
    }

    title = title.trim();
    if (title && sessionId) {
      await updateSessionTitle(sessionId, title);
      console.log(`[session] Title generated: "${title}"`);
    }
  } catch (err) {
    console.warn('[session] Failed to generate title:', err);
  }
}
