import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

/** Largest file the indexer reads (bytes) and the longest it waits for one file (ms). Beyond either the file is marked too_large or failed, never retried in a loop. */
export const MAX_EXTRACT_BYTES = 25 * 1024 * 1024;
export const EXTRACT_TIMEOUT_MS = 30_000;

export type ExtractKind = 'pdf' | 'docx';
export type ExtractResult = { status: 'done' | 'empty' | 'unsupported' | 'too_large' | 'failed'; text: string };

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** pdf and docx are indexed; everything else (images, spreadsheets, old .doc) is marked unsupported. */
export function kindOf(name: string, mime: string): ExtractKind | null {
  const n = name.toLowerCase();
  if (mime === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (mime === DOCX_MIME || n.endsWith('.docx')) return 'docx';
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('extract timeout')), ms); t.unref(); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** Text of one file's plain bytes. Never throws: a failure is a status. */
export async function extractText(bytes: Buffer, name: string, mime: string): Promise<ExtractResult> {
  const kind = kindOf(name, mime);
  if (!kind) return { status: 'unsupported', text: '' };
  if (bytes.length > MAX_EXTRACT_BYTES) return { status: 'too_large', text: '' };
  try {
    let text = '';
    if (kind === 'pdf') {
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      try { text = (await withTimeout(parser.getText(), EXTRACT_TIMEOUT_MS)).text; } finally { await parser.destroy().catch(() => undefined); }
    } else {
      text = (await withTimeout(mammoth.extractRawText({ buffer: bytes }), EXTRACT_TIMEOUT_MS)).value;
    }
    text = text.replace(/-- \d+ of \d+ --/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? { status: 'done', text } : { status: 'empty', text: '' };
  } catch {
    return { status: 'failed', text: '' };
  }
}
