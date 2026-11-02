/**
 * Automatic file names `SITE_TASK_DOC_APPROVEDDATE.ext` (ADR 0008 section 3). Computed when a file is shown or downloaded, from the site code, the task
 * code, the document code and the approved date. Before approval `DRAFT-<upload date>` stands for the approved date; a superseded or withdrawn version adds
 * `_v<n>`; a second file in the same slot adds `_<n>`; a candidate slot adds the candidate label. Every character outside [A-Za-z0-9-] becomes `-`, so
 * the name is safe in a header and on any file system whatever the user typed.
 */
export interface NameParts {
  site_code: string;
  task_code: string | null;
  doc_code: string;
  approved_date: string | null; // YYYY-MM-DD
  uploaded_at: Date | string;
  ext: string;
  version: number;
  is_current: boolean;
  candidate_label?: string | null;
  /** 1-based position of the file group among the slot's file groups (1 = first uploaded). */
  ordinal?: number;
}

export const safePart = (s: string): string => s.replace(/[^A-Za-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'X';
const ymd = (s: string): string => s.replace(/-/g, '').slice(0, 8);

export function displayName(p: NameParts): string {
  const uploaded = (p.uploaded_at instanceof Date ? p.uploaded_at.toISOString() : String(p.uploaded_at)).slice(0, 10);
  const date = p.approved_date ? ymd(p.approved_date) : `DRAFT-${ymd(uploaded)}`;
  const parts = [safePart(p.site_code), p.task_code ? safePart(p.task_code) : null, safePart(p.doc_code), p.candidate_label ? safePart(p.candidate_label) : null, date].filter((x): x is string => x !== null);
  let name = parts.join('_');
  if (p.ordinal && p.ordinal > 1) name += `_${p.ordinal}`;
  if (!p.is_current) name += `_v${p.version}`;
  const ext = p.ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  return `${name}.${ext}`;
}

/** A Content-Disposition value that is always an attachment with an ASCII-only name. */
export function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.');
  return `attachment; filename="${ascii}"`;
}

/** The name a user typed, kept as metadata only: control characters removed, 255 characters at most. */
export const cleanOriginalName = (s: string): string => [...s].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').slice(0, 255);
