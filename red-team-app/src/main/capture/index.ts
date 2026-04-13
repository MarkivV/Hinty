// Capture pipeline initialization.
// OCR is not used in the current flow (session.ts sends screenshots directly to the
// vision API), so we skip Tesseract worker init to save ~300ms startup time and ~50MB RAM.

export async function initCapture(): Promise<void> {
  console.log('[capture] Pipeline initialized (vision-only mode)');
}
