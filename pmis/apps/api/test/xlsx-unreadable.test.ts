import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { explainUnreadable, guardXlsx, normalizeSpreadsheetPrefixes } from '../src/templates/xlsx-guard';

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

describe('normalizeSpreadsheetPrefixes: a file with prefixed SpreadsheetML (x:workbook) from another program', () => {
  const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  /** Writes every SpreadsheetML element of the xl/ parts with the prefix x:, as the OpenXML SDK does. */
  function prefixed(buf: Buffer): Buffer {
    const files = unzipSync(new Uint8Array(buf));
    for (const n of Object.keys(files)) {
      if (!n.startsWith('xl/') || !n.endsWith('.xml')) continue;
      const t = strFromU8(files[n]!);
      if (!t.includes(`xmlns="${MAIN}"`)) continue;
      files[n] = strToU8(t.replace(/<(\/?)(?![?!])([A-Za-z_][\w.-]*)(?=[\s/>])/g, '<$1x:$2').replace(`xmlns="${MAIN}"`, `xmlns:x="${MAIN}"`));
    }
    return Buffer.from(zipSync(files));
  }

  it('reproduces the owner error, then reads the file after normalising, with its sheets and values', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Data').getCell('A1').value = 'Site ID';
    wb.getWorksheet('Data')!.getCell('A2').value = 'XX001';
    wb.addWorksheet('_tpl').getCell('A1').value = 'template_id';
    const bad = prefixed(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(strFromU8(unzipSync(new Uint8Array(bad))['xl/workbook.xml']!)).toMatch(/<x:workbook /);
    expect(guardXlsx('prefixed.xlsx', bad).ok).toBe(true);
    await expect(new ExcelJS.Workbook().xlsx.load(bad as unknown as ExcelJS.Buffer)).rejects.toThrow(); // the owner's file: "Cannot read properties of undefined (reading 'sheets')" when only workbook.xml is prefixed
    const plain = normalizeSpreadsheetPrefixes(bad);
    expect(plain).not.toBeNull();
    expect(guardXlsx('plain.xlsx', plain!).ok).toBe(true);
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(plain! as unknown as ExcelJS.Buffer);
    expect(back.worksheets.map((w) => w.name)).toEqual(['Data', '_tpl']);
    expect(back.getWorksheet('Data')!.getCell('A2').value).toBe('XX001');
  });

  it('leaves a plain Excel file alone (null), and a file whose root binds another prefix', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Data').getCell('A1').value = 1;
    expect(normalizeSpreadsheetPrefixes(Buffer.from(await wb.xlsx.writeBuffer()))).toBeNull();
    expect(normalizeSpreadsheetPrefixes(pkg('<y:workbook xmlns:y="urn:other"/>'))).toBeNull();
  });
});

describe('guardXlsx: end-of-directory record that another ZIP reader could read differently (security review 2026-11-09)', () => {
  it('refuses a package whose entries-on-this-disk count differs from the total, or that spans disks', () => {
    const ok = pkg('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
    expect(guardXlsx('ok.xlsx', ok).ok).toBe(true);
    const eocd = ok.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const split = Buffer.from(ok);
    split.writeUInt16LE(split.readUInt16LE(eocd + 8) + 1, eocd + 8);
    expect(guardXlsx('split.xlsx', split)).toMatchObject({ ok: false, reason: 'not_xlsx' });
    const disk = Buffer.from(ok);
    disk.writeUInt16LE(1, eocd + 4);
    expect(guardXlsx('disk.xlsx', disk)).toMatchObject({ ok: false, reason: 'not_xlsx' });
    expect(normalizeSpreadsheetPrefixes(split)).toBeNull();
  });
});
