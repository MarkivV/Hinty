/**
 * stream.ts — Shared streaming proxy for AI requests.
 *
 * Used by both the chat session and the meeting AI engine.
 * Streams responses from the backend proxy (hinty-web.vercel.app).
 */

import { getToken } from '../auth/tokenStore';

const API_BASE = 'https://hinty-web.vercel.app';

export interface StreamOptions {
  messages: Array<{ role: string; content: any }>;
  model: string;
  temperature?: number;
  maxTokens?: number;
  onToken: (token: string) => void;
  signal?: AbortSignal;
}

/**
 * Stream a chat completion via the backend proxy.
 * Returns the full response text.
 */
export async function streamCompletion(opts: StreamOptions): Promise<string> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated — please sign in');

  const payload = JSON.stringify({
    messages: opts.messages,
    model: opts.model,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 2048,
  });

  const response = await fetch(`${API_BASE}/api/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: payload,
    signal: opts.signal,
  });

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
    if (opts.signal?.aborted) {
      await reader.cancel();
      break;
    }

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
          opts.onToken(parsed.token);
        }
      } catch (e: any) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    }
  }

  return fullResponse;
}
