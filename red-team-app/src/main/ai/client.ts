import { getSettings, AI_MODEL } from '../settingsStore';
import { getSidePanelWindow } from '../windows/sidepanel';
import { getToken } from '../auth/tokenStore';
import { IPC_CHANNELS } from '../../shared/types';
import { buildVisionPrompt } from './prompt';
import { parseAiResponse } from './parser';
import { CaptureResult, AiResponse } from '../../shared/types';

const API_BASE = 'https://hinty-web.vercel.app';

export function resetClient(): void {
  // No local client to reset — calls go through backend
}

export async function analyzeCapture(capture: CaptureResult): Promise<AiResponse> {
  const settings = getSettings();
  const panel = getSidePanelWindow();
  const token = getToken();

  if (!token) {
    throw new Error('Not authenticated — please log in first');
  }

  const messages = buildVisionPrompt(capture);

  console.log(`[ai] Using vision mode via backend proxy`);

  const response = await fetch(`${API_BASE}/api/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      messages,
      model: AI_MODEL,
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`AI request failed (${response.status}): ${errorBody}`);
  }

  // Parse SSE stream from backend (with proper cross-chunk buffering)
  let fullResponse = '';
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader) {
    throw new Error('No response body');
  }

  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line for next chunk

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();

      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        if (parsed.error) {
          throw new Error(parsed.error);
        }
        if (parsed.token) {
          fullResponse += parsed.token;
          if (panel && !panel.isDestroyed()) {
            panel.webContents.send(IPC_CHANNELS.SIDEPANEL_STREAM_TOKEN, parsed.token);
          }
        }
      } catch (e) {
        // Skip malformed SSE lines
        if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
          throw e;
        }
      }
    }
  }

  if (panel && !panel.isDestroyed()) {
    panel.webContents.send(IPC_CHANNELS.AI_RESPONSE_COMPLETE);
  }

  console.log(`[ai] Response complete — ${fullResponse.length} chars`);

  const parsed = parseAiResponse(fullResponse, capture.sessionId, capture.ocr);
  return parsed;
}
