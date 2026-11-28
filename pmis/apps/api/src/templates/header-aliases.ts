/**
 * Alternative names of a column (migration 0640). The data upload checks the header row of a file against the template that was issued. A header that equals the issued
 * label is the column, and so is a header that equals one of the aliases the column has (ignoring case and surrounding spaces). Anything else is a changed header.
 */
export interface HeaderColumn { code: string; header: string; kind: string }

const norm = (s: string): string => s.trim().toLowerCase();

/** Does every header of the file name the column at its place, by its label or by one of its aliases? (The count of columns must match too.) */
export function headersMatchWithAliases(cols: HeaderColumn[], headers: string[], aliasesByCode: Map<string, string[]>): boolean {
  if (headers.length !== cols.length) return false;
  return cols.every((c, i) => {
    const h = norm(headers[i] ?? '');
    if (h === norm(c.header)) return true;
    if (c.kind !== 'field' && c.kind !== 'custom') return false;
    return (aliasesByCode.get(c.code) ?? []).some((a) => norm(a) === h);
  });
}
