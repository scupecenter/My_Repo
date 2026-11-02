/**
 * Suggests the document slot of a file from its name (multi-file upload). A match is the document code as a token of the file name (strongest) or the
 * words of the document name found in it. Nothing is stored: the user confirms in a dropdown.
 */
export interface SlotKey {
  slot_id: string;
  doc_code: string;
  name_en: string;
  name_ar: string | null;
  candidate_label?: string | null;
}

const STOP = new Set(['and', 'the', 'for', 'of', 'or', 'a', 'to', 'in', 'on', 'when', 'each', 'one', 'per', 'only', 'signed', 'scan', 'scanned', 'with', 'is', 'required']);

const tokens = (s: string): string[] => s.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').split(/[^a-z0-9؀-ۿ]+/).filter(Boolean);

export function suggestSlots(fileName: string, slots: SlotKey[]): { slot_id: string; doc_code: string; score: number }[] {
  const ft = tokens(fileName);
  const fset = new Set(ft);
  const joined = ft.join('');
  const out: { slot_id: string; doc_code: string; score: number }[] = [];
  for (const s of slots) {
    const code = s.doc_code.toLowerCase();
    let score = 0;
    const codeParts = code.split('_');
    const full = fset.has(code) || (joined.includes(code.replace(/_/g, '')) && code.length >= 3) || (codeParts.length > 1 && codeParts.every((p) => fset.has(p)));
    // a longer code that matches is the better answer (B7_DN over B7)
    if (full) score = 0.9 + 0.01 * Math.min(codeParts.length, 5);
    const words = [...new Set([...tokens(s.name_en), ...(s.name_ar ? tokens(s.name_ar) : [])])].filter((w) => w.length >= 3 && !STOP.has(w) && !/^[a-z]\d+[a-z]?$/.test(w));
    if (words.length > 0) {
      const hit = words.filter((w) => fset.has(w) || joined.includes(w)).length;
      if (hit > 0) score = Math.max(score, Math.min(0.85, 0.3 + 0.55 * (hit / words.length)));
    }
    if (s.candidate_label && fset.has(s.candidate_label.toLowerCase())) score = Math.min(1, score + 0.05);
    if (score > 0) out.push({ slot_id: s.slot_id, doc_code: s.doc_code, score: Math.round(score * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score || a.doc_code.localeCompare(b.doc_code, 'en')).slice(0, 5);
}
