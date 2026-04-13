import { clipboard } from 'electron';

export function captureClipboard(): string {
  const text = clipboard.readText();
  console.log(`[clipboard] ${text.length} chars`);
  return text;
}
