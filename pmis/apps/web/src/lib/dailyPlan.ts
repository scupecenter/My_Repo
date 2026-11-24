import type { DailyPlanRow } from '@/api/dailyPlan';

/** The two tabs of My Work > Daily Plan (owner decision W7). */
export type DailyPlanTab = 'progress' | 'tomorrow';

/** Every column a tab may show (Settings > My Work > Daily Plan chooses which and in which order). */
export const DP_COLUMNS = ['no', 'site_code', 'site_name', 'tower_owner', 'owner_id', 'latitude', 'longitude', 'region', 'site_type', 'sow', 'contractor', 'aat_se',
  'access_valid', 'planned_work', 'actual_work', 'reason', 'remark'] as const;
export type DpColumn = (typeof DP_COLUMNS)[number];

/** The columns of the owner's Excel sheet, in its exact order. Export and Copy for email always keep this order. */
export const OWNER_COLUMNS: Record<DailyPlanTab, DpColumn[]> = {
  progress: ['no', 'site_code', 'tower_owner', 'owner_id', 'latitude', 'longitude', 'region', 'site_type', 'sow', 'contractor', 'aat_se', 'planned_work', 'actual_work', 'reason'],
  tomorrow: ['no', 'site_code', 'tower_owner', 'owner_id', 'latitude', 'longitude', 'region', 'site_type', 'sow', 'contractor', 'aat_se', 'access_valid', 'planned_work', 'remark'],
};

/** The headers of the owner's sheet (English, as in the sheet; the email and the export keep them). */
export const OWNER_HEADERS: Record<DpColumn, string> = {
  no: 'No', site_code: 'Site ID', site_name: 'Site Name', tower_owner: 'Tower Owner', owner_id: 'Owner ID', latitude: 'Latitude', longitude: 'Longitude', region: 'Region',
  site_type: 'Site Type', sow: 'SOW', contractor: 'Vendor / Contractor Name', aat_se: 'AAT SE', access_valid: 'Access Valid', planned_work: 'Planned Work',
  actual_work: 'Actual Work', reason: 'Reason (if not reach target)', remark: 'Remark',
};

/** The auto-filled columns a person may change by hand (Site ID, Site Name and Region identify the row). */
export const OVERRIDE_KEYS = ['tower_owner', 'owner_id', 'latitude', 'longitude', 'site_type', 'sow', 'contractor', 'aat_se', 'access_valid', 'planned_work', 'actual_work'] as const;

/** The text of a cell: the row number, Reason and Remark, or the value shown (the manual value over the auto one). */
export function cellValue(row: DailyPlanRow, col: DpColumn, n: number): string {
  if (col === 'no') return String(n);
  if (col === 'reason') return row.reason ?? '';
  if (col === 'remark') return row.remark ?? '';
  const v = (row.values as Record<string, string | null | undefined>)[col];
  return v ?? '';
}

/** The filters of the screen (+ Filter): region, contractor, AAT SE, SOW, and the search box. Kept in the URL and in saved views. */
export interface DpFilters { region: string; contractor: string; aat_se: string; sow: string; q: string }
export const EMPTY_FILTERS: DpFilters = { region: '', contractor: '', aat_se: '', sow: '', q: '' };

/** The rows that pass the filters. `regions` is the region scope already resolved (empty = all). A contractor or AAT SE filter matches one name in the cell. */
export function filterRows(rows: DailyPlanRow[], f: Omit<DpFilters, 'region'>, regions: number[]): DailyPlanRow[] {
  const has = (cell: string | null | undefined, v: string) => !v || (cell ?? '').split(',').map((x) => x.trim()).includes(v);
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => (regions.length === 0 || regions.includes(r.region_id))
    && has(r.values.contractor, f.contractor) && has(r.values.aat_se, f.aat_se) && (!f.sow || (r.values.sow ?? '') === f.sow)
    && (!q || r.site_code.toLowerCase().includes(q) || (r.site_name ?? '').toLowerCase().includes(q) || (r.values.owner_id ?? '').toLowerCase().includes(q)));
}

/** The distinct names of a column of the rows (for the + Filter options). */
export function optionsOf(rows: DailyPlanRow[], col: 'contractor' | 'aat_se' | 'sow'): string[] {
  const s = new Set<string>();
  for (const r of rows) {
    const v = r.values[col];
    if (!v) continue;
    if (col === 'sow') s.add(v);
    else v.split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => s.add(x));
  }
  return [...s].sort((a, b) => a.localeCompare(b));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CELL = 'border:1px solid #8a8a8a;padding:4px 6px;vertical-align:top;font-family:Calibri,Arial,sans-serif;font-size:11pt';
const HEAD = `${CELL};background:#d9e2f3;font-weight:bold`;

export interface EmailTable { title: string; tab: DailyPlanTab; rows: DailyPlanRow[] }

/** One table as HTML that pastes cleanly into Outlook (inline styles only, line breaks as <br>). */
export function tableHtml(t: EmailTable): string {
  const cols = OWNER_COLUMNS[t.tab];
  const head = cols.map((c) => `<th style="${HEAD}">${esc(OWNER_HEADERS[c])}</th>`).join('');
  const body = t.rows.map((r, i) => `<tr>${cols.map((c) => `<td style="${CELL}">${esc(cellValue(r, c, i + 1)).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('');
  return `<p style="font-family:Calibri,Arial,sans-serif;font-size:13pt;font-weight:bold;margin:12px 0 4px">${esc(t.title)}</p>`
    + `<table style="border-collapse:collapse;border:1px solid #8a8a8a" cellspacing="0" cellpadding="0"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The plain-text fallback: the title, then one tab-separated line per row (a line break inside a cell becomes "; "). */
export function tableText(t: EmailTable): string {
  const cols = OWNER_COLUMNS[t.tab];
  const line = (xs: string[]) => xs.map((x) => x.replace(/\t/g, ' ').replace(/\r?\n/g, '; ')).join('\t');
  return [t.title, line(cols.map((c) => OWNER_HEADERS[c])), ...t.rows.map((r, i) => line(cols.map((c) => cellValue(r, c, i + 1))))].join('\n');
}

/** Both tables of the email: "Daily Progress <date>" and "Tomorrow Plan <date>". */
export function emailContent(progress: EmailTable, tomorrow: EmailTable): { html: string; text: string } {
  return {
    html: `<div>${tableHtml(progress)}<br>${tableHtml(tomorrow)}</div>`,
    text: `${tableText(progress)}\n\n${tableText(tomorrow)}\n`,
  };
}

/** Puts the HTML table on the clipboard with the plain-text fallback; a browser without rich clipboard gets the text only. */
export async function copyToClipboard(html: string, text: string): Promise<'rich' | 'text'> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip && typeof clip.write === 'function' && typeof ClipboardItem !== 'undefined') {
    await clip.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    return 'rich';
  }
  if (clip && typeof clip.writeText === 'function') {
    await clip.writeText(text);
    return 'text';
  }
  throw new Error('clipboard_unavailable');
}

/** Today in the browser (YYYY-MM-DD, local time). */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
