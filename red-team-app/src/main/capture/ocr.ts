import Tesseract from 'tesseract.js';
import { OcrResult, OcrWord } from '../../shared/types';

let worker: Tesseract.Worker | null = null;

export async function initOcrWorker(): Promise<void> {
  if (worker) return;
  worker = await Tesseract.createWorker('eng');
  console.log('[ocr] Worker initialized');
}

export async function runOcr(pngBuffer: Buffer): Promise<OcrResult> {
  if (!worker) {
    await initOcrWorker();
  }

  const result = await worker!.recognize(pngBuffer);

  const words: OcrWord[] = result.data.words.map((w) => ({
    text: w.text,
    bbox: {
      x0: w.bbox.x0,
      y0: w.bbox.y0,
      x1: w.bbox.x1,
      y1: w.bbox.y1,
    },
    confidence: w.confidence,
  }));

  const totalConfidence = words.reduce((sum, w) => sum + w.confidence, 0);
  const averageConfidence = words.length > 0 ? totalConfidence / words.length : 0;

  console.log(`[ocr] ${words.length} words, avg confidence: ${averageConfidence.toFixed(1)}%`);

  return {
    fullText: result.data.text,
    words,
    averageConfidence,
  };
}

export async function terminateOcrWorker(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
    console.log('[ocr] Worker terminated');
  }
}
