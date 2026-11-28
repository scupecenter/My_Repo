import { describe, expect, it } from 'vitest';
import { headersMatchWithAliases, type HeaderColumn } from '../src/templates/header-aliases';

/** 0640: the pure part of the alias rule of the data upload, with no database. */
const cols: HeaderColumn[] = [
  { code: 'site', header: 'Site ID', kind: 'site' },
  { code: 'po_no', header: 'PO number', kind: 'field' },
  { code: 'note', header: 'Note', kind: 'custom' },
];
const aliases = new Map<string, string[]>([['po_no', ['PO No', 'Order number']], ['note', ['Remarks']], ['site', ['Location']]]);

describe('headersMatchWithAliases', () => {
  it('accepts the issued headers and the aliases of a column, ignoring case and spaces', () => {
    expect(headersMatchWithAliases(cols, ['Site ID', 'PO number', 'Note'], aliases)).toBe(true);
    expect(headersMatchWithAliases(cols, ['Site ID', '  po no ', 'REMARKS'], aliases)).toBe(true);
    expect(headersMatchWithAliases(cols, ['site id', 'Order number', 'note'], aliases)).toBe(true);
  });
  it('refuses a name that is neither the label nor an alias, or an alias of another column', () => {
    expect(headersMatchWithAliases(cols, ['Site ID', 'Amount', 'Note'], aliases)).toBe(false);
    expect(headersMatchWithAliases(cols, ['Site ID', 'Remarks', 'Note'], aliases)).toBe(false);
  });
  it('does not apply aliases to a column that is not a register column, and needs the same count', () => {
    expect(headersMatchWithAliases(cols, ['Location', 'PO number', 'Note'], aliases)).toBe(false);
    expect(headersMatchWithAliases(cols, ['Site ID', 'PO number'], aliases)).toBe(false);
    expect(headersMatchWithAliases(cols, ['Site ID', 'PO number', 'Note', 'Extra'], aliases)).toBe(false);
  });
});
