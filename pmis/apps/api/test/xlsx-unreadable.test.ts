import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { explainUnreadable, guardXlsx } from '../src/templates/xlsx-guard';

/** A minimal package that passes the guard (it has [Content_Types].xml and xl/workbook.xml) with a chosen workbook part. */
function pkg(workbookXml: string): Buffer {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/workbook.xml': strToU8(workbookXml),
  }));
}

describe('explainUnreadable: why a workbook could not be read, in words the user can act on', () => {
  it('names a Strict Open XML file and says how to save it again', () => {
    const buf = pkg('<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"/>');
    expect(guardXlsx('strict.xlsx', buf).ok).toBe(true);
    const r = explainUnreadable(buf, new Error('Cannot read properties of undefined'));
    expect(r.detail).toMatch(/Strict Open XML/);
    expect(r.detail).toMatch(/Excel Workbook \(\*\.xlsx\)/);
    expect(r.logged).toBe('Cannot read properties of undefined');
  });

  it('names copied formulas (the shared-formula error of the parser) and asks for values only', () => {
    const buf = pkg('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
    const r = explainUnreadable(buf, new Error('Shared Formula master must exist above and or left of clone for cell C7\n  at x'));
    expect(r.detail).toMatch(/formulas copied across cells/);
    expect(r.detail).toMatch(/values only/);
    expect(r.logged).toBe('Shared Formula master must exist above and or left of clone for cell C7');
  });

  it('otherwise gives the general advice, and keeps the logged cause short', () => {
    const buf = pkg('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
    const r = explainUnreadable(buf, new Error('x'.repeat(500)));
    expect(r.detail).toMatch(/could not be read as an Excel workbook/);
    expect(r.detail).toMatch(/values only/);
    expect(r.logged.length).toBe(200);
  });
});
