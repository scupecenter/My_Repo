/**
 * The matching rule of global search, in the API, for highlighting (plan F4, migration 0099).
 *
 * The database normalises both the stored text and the query with search_norm(); this file does the same for one title at a time,
 * so the highlight matches what the search found. It works per code point and keeps, for every folded character, the place of the raw
 * character it came from, so the ranges returned are offsets into the raw title (UTF-16 code units, as the contract says).
 */

/** Tashkeel, superscript alef, tatweel and the zero-width joiners: removed. */
const DROP = /^[ً-ٰٟـ‌-‏]$/;
/** Alef forms to alef, taa marbuta to haa, alef maqsura and hamza on yaa to yaa, hamza on waw to waw. */
const LETTERS: Record<string, string> = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي' };
/** Arabic-Indic (U+0660..0669) then Persian (U+06F0..06F9) digits: index % 10 is the Latin digit. */
const DIGITS = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';

/** One code point folded to the text it matches as (possibly empty). Latin diacritics go through NFD. */
function foldCodePoint(cp: string): string {
  if (DROP.test(cp)) return '';
  let c = cp.normalize('NFD').replace(/\p{M}/gu, '');
  const d = c.length === 1 ? DIGITS.indexOf(c) : -1;
  if (d >= 0) c = String(d % 10);
  c = LETTERS[c] ?? c;
  const lower = c.toLowerCase();
  return lower.length === c.length ? lower : c;
}

/** The folded text of `raw`, and for each of its UTF-16 units the [start, end) of the raw character it came from. */
function fold(raw: string): { text: string; spans: [number, number][] } {
  let text = '';
  const spans: [number, number][] = [];
  let offset = 0;
  for (const cp of raw) {
    const end = offset + cp.length;
    for (const unit of foldCodePoint(cp)) {
      text += unit;
      spans.push([offset, end]);
    }
    offset = end;
  }
  return { text, spans };
}

/**
 * Ranges of `title` that the query `term` matches, as [start, end) offsets into `title`. Every non-overlapping occurrence is returned.
 * An empty term (only tashkeel, say) matches nothing.
 */
export function matchRanges(title: string, term: string): [number, number][] {
  const needle = fold(term).text;
  if (needle.length === 0) return [];
  const hay = fold(title);
  const ranges: [number, number][] = [];
  let at = hay.text.indexOf(needle);
  while (at >= 0) {
    const first = hay.spans[at];
    const last = hay.spans[at + needle.length - 1];
    if (first && last) ranges.push([first[0], last[1]]);
    at = hay.text.indexOf(needle, at + needle.length);
  }
  return ranges;
}
