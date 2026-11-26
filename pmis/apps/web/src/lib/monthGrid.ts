export interface DayItem { id: string; label: string; date: string; late: boolean }
export interface MonthCell { date: string; inMonth: boolean; items: DayItem[] }

const pad = (n: number): string => String(n).padStart(2, '0');

/** Month grid (weeks of 7, starting on `weekStart`: 0 = Sunday) for year/month (1-12), with the items placed on their YYYY-MM-DD date. Items with no date are returned apart. */
export function monthGrid(year: number, month: number, items: DayItem[], weekStart = 6): { cells: MonthCell[]; undated: number } {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() - weekStart + 7) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const total = Math.ceil((lead + days) / 7) * 7;
  const by = new Map<string, DayItem[]>();
  let undated = 0;
  for (const it of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date)) { undated++; continue; }
    by.set(it.date, [...(by.get(it.date) ?? []), it]);
  }
  const cells: MonthCell[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(year, month - 1, 1 - lead + i));
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    cells.push({ date, inMonth: d.getUTCMonth() === month - 1, items: by.get(date) ?? [] });
  }
  return { cells, undated };
}
