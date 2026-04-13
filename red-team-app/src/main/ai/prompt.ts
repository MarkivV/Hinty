import OpenAI from 'openai';
import * as fs from 'fs';
import { CaptureResult } from '../../shared/types';
import { getSettings } from '../settingsStore';

const SYSTEM_PROMPT = `You are an expert exam assistant. Analyze the screen content and identify all questions visible.

For each question found, respond in this exact format:

---QUESTION---
Type: [multiple_choice | true_false | open]
Question: [the question text]
Answer: [the correct answer]
Anchor: [for MC/TF: the exact text of the correct option as it appears on screen, for open: leave empty]
---END---

Rules:
- Detect ALL questions visible on screen simultaneously
- For multiple choice: identify the correct option and provide its exact text as Anchor
- For true/false: answer True or False, anchor is the correct option text
- For open questions: provide a clear, concise answer
- If audio transcript is provided, use it as additional context
- If clipboard content is provided, use it as additional context
- Be precise with the Anchor text — it must match the on-screen text exactly for highlighting to work`;

function loadKnowledgeBase(): string {
  const settings = getSettings();
  if (!settings.knowledgeBaseFiles || settings.knowledgeBaseFiles.length === 0) return '';

  const contents: string[] = [];
  for (const filePath of settings.knowledgeBaseFiles) {
    try {
      if (fs.existsSync(filePath) && filePath.endsWith('.txt')) {
        const text = fs.readFileSync(filePath, 'utf-8');
        contents.push(`[File: ${filePath.split('/').pop()}]\n${text}`);
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (contents.length === 0) return '';
  return '\n\n--- KNOWLEDGE BASE ---\n' + contents.join('\n\n');
}

export function buildPrompt(capture: CaptureResult): OpenAI.ChatCompletionMessageParam[] {
  const knowledgeBase = loadKnowledgeBase();

  let userContent = `Screen OCR Text:\n${capture.ocr.fullText}`;

  if (capture.audioTranscript) {
    userContent += `\n\nAudio Transcript (last 30s):\n${capture.audioTranscript}`;
  }

  if (capture.clipboardContent) {
    userContent += `\n\nClipboard Content:\n${capture.clipboardContent}`;
  }

  if (knowledgeBase) {
    userContent += knowledgeBase;
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

export function buildVisionPrompt(capture: CaptureResult): OpenAI.ChatCompletionMessageParam[] {
  const knowledgeBase = loadKnowledgeBase();
  const base64 = capture.screenshot.toString('base64');

  let textContext = '';
  if (capture.audioTranscript) {
    textContext += `\nAudio Transcript (last 30s):\n${capture.audioTranscript}`;
  }
  if (capture.clipboardContent) {
    textContext += `\nClipboard Content:\n${capture.clipboardContent}`;
  }
  if (knowledgeBase) {
    textContext += knowledgeBase;
  }

  const userContent: OpenAI.ChatCompletionContentPart[] = [
    {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${base64}`,
        detail: 'high',
      },
    },
  ];

  if (textContext) {
    userContent.push({
      type: 'text',
      text: `Additional context:${textContext}`,
    });
  } else {
    userContent.push({
      type: 'text',
      text: 'Analyze all questions visible in this screenshot.',
    });
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}
