import { unzipSync } from 'fflate';

/**
 * Content-type check by magic bytes (ADR 0008, owner rule "security"). The name the user typed and the content type the browser sent are never
 * trusted: the type is decided from the bytes, and the stored extension comes from that decision.
 */
export type RejectReason = 'empty' | 'executable' | 'archive' | 'macro' | 'script' | 'html' | 'unknown_type' | 'format_not_allowed' | 'too_many_files';

export interface Sniffed {
  /** Canonical lower-case extension: pdf, jpg, png, heic, gif, webp, tiff, xlsx, docx, pptx, eml, msg, svg. */
  ext: string;
  mime: string;
  image: boolean;
}

export type SniffResult = ({ ok: true } & Sniffed) | { ok: false; reason: RejectReason; detail: string };

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  heic: 'image/heic',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
  svg: 'image/svg+xml',
};
const IMAGE = new Set(['jpg', 'png', 'gif', 'webp', 'tiff', 'heic', 'svg']);

export const mimeOfExt = (ext: string): string => MIME[ext] ?? 'application/octet-stream';
/** jpeg and jpg are one format. */
export const canonicalExt = (ext: string): string => {
  const e = ext.toLowerCase().replace(/^\./, '');
  return e === 'jpeg' ? 'jpg' : e === 'tif' ? 'tiff' : e;
};

const ok = (ext: string): SniffResult => ({ ok: true, ext, mime: MIME[ext] ?? 'application/octet-stream', image: IMAGE.has(ext) });
const no = (reason: RejectReason, detail: string): SniffResult => ({ ok: false, reason, detail });

const startsWith = (b: Buffer, sig: number[], at = 0): boolean => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (b: Buffer, from: number, to: number): string => b.subarray(from, to).toString('latin1');

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const SCRIPTY = /<script[\s>]|\son[a-z]+\s*=|javascript:|<foreignobject|<iframe|<embed|<object|<link[\s>]|<!entity/i;

function sniffZip(data: Buffer): SniffResult {
  let names: string[] = [];
  try {
    unzipSync(new Uint8Array(data), { filter: (f) => { names.push(f.name); return false; } });
  } catch {
    return no('archive', 'Archives are not accepted.');
  }
  names = names.filter((n) => n !== '');
  if (names.some((n) => n.startsWith('/') || n.includes('..') || n.includes('\\') || /^[a-z]:/i.test(n))) return no('archive', 'Archives with paths are not accepted.');
  if (!names.includes('[Content_Types].xml')) return no('archive', 'Archives are not accepted.');
  if (names.some((n) => /vbaproject\.bin$/i.test(n) || /\/macros\//i.test(n) || /vbadata\.xml$/i.test(n) || /\.(exe|dll|bat|cmd|js|vbs|ps1|sh|jar)$/i.test(n) || /^.*\/embeddings\/.*\.bin$/i.test(n))) {
    return no('macro', 'Documents with macros or embedded programs are not accepted.');
  }
  if (names.some((n) => n.startsWith('xl/'))) return ok('xlsx');
  if (names.some((n) => n.startsWith('word/'))) return ok('docx');
  if (names.some((n) => n.startsWith('ppt/'))) return ok('pptx');
  return no('archive', 'Archives are not accepted.');
}

function sniffText(data: Buffer): SniffResult {
  const head = data.subarray(0, 64 * 1024);
  if (head.includes(0)) return no('unknown_type', 'The file type is not recognised.');
  const text = head.toString('utf8');
  const trimmed = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart();
  const lower = trimmed.slice(0, 2000).toLowerCase();
  if (/^<svg[\s>]/.test(lower) || (/^<\?xml/.test(lower) && /<svg[\s>]/.test(lower))) {
    if (SCRIPTY.test(text)) return no('script', 'SVG files with scripts are not accepted.');
    return ok('svg');
  }
  if (/^(<!doctype\s+html|<html|<head|<body|<script|<iframe|<meta)/.test(lower) || /<script[\s>]/i.test(trimmed.slice(0, 5000))) {
    return no('html', 'Web pages and scripts are not accepted.');
  }
  const headerLines = trimmed.split(/\r?\n/).slice(0, 40).filter((l) => /^(received|from|to|cc|bcc|subject|date|message-id|mime-version|return-path|delivered-to|content-type|x-[\w-]+|reply-to|in-reply-to|references):/i.test(l));
  if (headerLines.length >= 2 && /^(received|from|to|subject|date|message-id|mime-version|return-path|delivered-to|x-[\w-]+):/i.test(trimmed)) return ok('eml');
  return no('unknown_type', 'The file type is not recognised.');
}

export function sniff(data: Buffer, fileName = ''): SniffResult {
  if (data.length === 0) return no('empty', 'The file is empty.');
  // programs and scripts
  if (startsWith(data, [0x4d, 0x5a]) || startsWith(data, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(data, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(data, [0xfe, 0xed, 0xfa, 0xcf]) ||
      startsWith(data, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(data, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(data, [0xca, 0xfe, 0xba, 0xbe]) || startsWith(data, [0x23, 0x21])) {
    return no('executable', 'Programs and scripts are not accepted.');
  }
  if (data.subarray(0, 1024).includes('%PDF-')) return ok('pdf');
  if (startsWith(data, [0xff, 0xd8, 0xff])) return ok('jpg');
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ok('png');
  if (ascii(data, 0, 4) === 'GIF8') return ok('gif');
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return ok('webp');
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) return ok('tiff');
  if (ascii(data, 4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(data, 8, 12).toLowerCase())) return ok('heic');
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06])) return sniffZip(data);
  if (ascii(data, 0, 4) === 'Rar!' || startsWith(data, [0x37, 0x7a, 0xbc, 0xaf]) || startsWith(data, [0x1f, 0x8b]) || ascii(data, 0, 3) === 'BZh' ||
      startsWith(data, [0xfd, 0x37, 0x7a, 0x58, 0x5a]) || ascii(data, 257, 262) === 'ustar') {
    return no('archive', 'Archives are not accepted.');
  }
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // Compound files: Outlook messages are accepted; legacy Office files can carry macros and are not.
    return /\.msg$/i.test(fileName) ? ok('msg') : no('macro', 'Old Office files can carry macros and are not accepted.');
  }
  return sniffText(data);
}

/** The reason a sniffed type is not in the document's format list, or null when it is. */
export function formatAllowed(s: Sniffed, formats: string[]): boolean {
  const allowed = new Set(formats.map(canonicalExt));
  return allowed.has(s.ext);
}
