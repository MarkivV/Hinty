import { AiResponse, AiAnswer, QuestionType, OcrResult, OcrWord } from '../../shared/types';

function detectQuestionType(typeStr: string): QuestionType {
  const t = typeStr.toLowerCase().trim();
  if (t.includes('multiple_choice') || t.includes('multiple choice')) return QuestionType.MultipleChoice;
  if (t.includes('true_false') || t.includes('true/false') || t.includes('true false')) return QuestionType.TrueFalse;
  if (t.includes('open')) return QuestionType.Open;
  return QuestionType.Unknown;
}

function findAnchorBbox(anchorText: string, ocr: OcrResult): OcrWord['bbox'] | undefined {
  if (!anchorText) return undefined;

  const anchor = anchorText.toLowerCase().trim();

  // Try exact word match first
  for (const word of ocr.words) {
    if (word.text.toLowerCase().trim() === anchor) {
      return word.bbox;
    }
  }

  // Try to find a sequence of words that matches the anchor text
  const anchorWords = anchor.split(/\s+/);
  if (anchorWords.length > 1) {
    for (let i = 0; i <= ocr.words.length - anchorWords.length; i++) {
      const slice = ocr.words.slice(i, i + anchorWords.length);
      const sliceText = slice.map((w) => w.text.toLowerCase().trim()).join(' ');
      if (sliceText === anchor || sliceText.includes(anchor) || anchor.includes(sliceText)) {
        // Merge bounding boxes
        return {
          x0: Math.min(...slice.map((w) => w.bbox.x0)),
          y0: Math.min(...slice.map((w) => w.bbox.y0)),
          x1: Math.max(...slice.map((w) => w.bbox.x1)),
          y1: Math.max(...slice.map((w) => w.bbox.y1)),
        };
      }
    }
  }

  // Fuzzy: find word that contains the anchor or vice versa
  for (const word of ocr.words) {
    const w = word.text.toLowerCase().trim();
    if (w.includes(anchor) || anchor.includes(w)) {
      return word.bbox;
    }
  }

  return undefined;
}

export function parseAiResponse(raw: string, sessionId: string, ocr: OcrResult): AiResponse {
  const answers: AiAnswer[] = [];

  // Split by ---QUESTION--- markers
  const blocks = raw.split(/---QUESTION---/i).filter((b) => b.trim());

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    const typeMatch = block.match(/Type:\s*(.+)/i);
    const questionMatch = block.match(/Question:\s*(.+)/i);
    const answerMatch = block.match(/Answer:\s*(.+)/i);
    const anchorMatch = block.match(/Anchor:\s*(.+)/i);

    if (!answerMatch) continue;

    const questionType = typeMatch ? detectQuestionType(typeMatch[1]) : QuestionType.Unknown;
    const questionText = questionMatch ? questionMatch[1].trim() : '';
    const answerText = answerMatch[1].trim();
    const anchorText = anchorMatch ? anchorMatch[1].trim() : '';

    // Skip empty anchors
    const effectiveAnchor = anchorText && anchorText !== 'empty' && anchorText !== '-' ? anchorText : '';

    const anchorBbox = effectiveAnchor ? findAnchorBbox(effectiveAnchor, ocr) : undefined;

    answers.push({
      questionIndex: i,
      questionType,
      questionText,
      answerText,
      anchorText: effectiveAnchor || undefined,
      anchorBbox,
    });
  }

  // If no structured format detected, treat entire response as a single open answer
  if (answers.length === 0 && raw.trim().length > 0) {
    answers.push({
      questionIndex: 0,
      questionType: QuestionType.Open,
      questionText: '',
      answerText: raw.trim(),
    });
  }

  console.log(`[parser] Parsed ${answers.length} answers from response`);
  return { sessionId, answers, rawResponse: raw };
}
