/**
 * documents.ts — Extract text from uploaded meeting documents.
 *
 * Supports: PDF, DOCX, XLSX, TXT, MD
 * Text extraction is fast (< 1 second for most files).
 * Extracted text is stored with the meeting session for AI context.
 */

import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import { MeetingDocument } from '../../shared/types';

// ── File type detection ──

type SupportedType = 'pdf' | 'docx' | 'xlsx' | 'txt' | 'md';

const EXTENSION_MAP: Record<string, SupportedType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.doc': 'docx',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.csv': 'txt',
  '.tsv': 'txt',
  '.txt': 'txt',
  '.md': 'md',
  '.markdown': 'md',
  '.rtf': 'txt',
};

function getFileType(filePath: string): SupportedType | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] || null;
}

// ── Extractors ──

async function extractPdf(filePath: string): Promise<string> {
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text || '';
}

async function extractDocx(filePath: string): Promise<string> {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

async function extractXlsx(filePath: string): Promise<string> {
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath);

  const lines: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    lines.push(`--- Sheet: ${sheetName} ---`);

    // Convert to array of arrays
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    for (const row of rows) {
      const cells = row.map((cell: any) => String(cell ?? '').trim()).filter(Boolean);
      if (cells.length > 0) {
        lines.push(cells.join('\t'));
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function extractText(filePath: string): Promise<string> {
  return fs.readFileSync(filePath, 'utf-8');
}

// ── Main API ──

/**
 * Extract text from a file and return a MeetingDocument.
 * Throws if the file type is unsupported or extraction fails.
 */
export async function processDocument(filePath: string): Promise<MeetingDocument> {
  const fileType = getFileType(filePath);
  if (!fileType) {
    throw new Error(`Unsupported file type: ${path.extname(filePath)}`);
  }

  const fileName = path.basename(filePath);
  console.log(`[documents] Processing: ${fileName} (${fileType})`);

  let extractedText: string;

  switch (fileType) {
    case 'pdf':
      extractedText = await extractPdf(filePath);
      break;
    case 'docx':
      extractedText = await extractDocx(filePath);
      break;
    case 'xlsx':
      extractedText = await extractXlsx(filePath);
      break;
    case 'txt':
    case 'md':
      extractedText = await extractText(filePath);
      break;
    default:
      throw new Error(`No extractor for type: ${fileType}`);
  }

  // Clean up extracted text
  extractedText = extractedText
    .replace(/\r\n/g, '\n')        // normalize line endings
    .replace(/\n{3,}/g, '\n\n')    // collapse excessive blank lines
    .trim();

  console.log(`[documents] Extracted ${extractedText.length} chars from ${fileName}`);

  return {
    id: nanoid(),
    fileName,
    fileType,
    extractedText,
    uploadedAt: Date.now(),
  };
}

/**
 * Get the supported file extensions for the file picker dialog.
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP).map(ext => ext.slice(1)); // remove leading dot
}

/**
 * Build a combined context string from multiple documents.
 * Truncates individual documents if the total would exceed maxChars.
 */
export function buildDocumentContext(docs: MeetingDocument[], maxChars = 30000): string {
  if (docs.length === 0) return '';

  const parts: string[] = [];
  let totalChars = 0;
  const perDocLimit = Math.floor(maxChars / docs.length);

  for (const doc of docs) {
    let text = doc.extractedText;
    if (text.length > perDocLimit) {
      text = text.slice(0, perDocLimit) + '\n... [truncated]';
    }
    parts.push(`=== ${doc.fileName} ===\n${text}`);
    totalChars += text.length;
  }

  return parts.join('\n\n');
}
