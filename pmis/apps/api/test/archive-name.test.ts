import { describe, expect, it } from 'vitest';
import { archiveName } from '../src/documents/naming';

describe('Library Archive file name (zip)', () => {
  it('is DocType_SiteID_Number_vN.ext', () => {
    expect(archiveName({ doc_code: 'CW-DN', site_code: 'TRI-0012', doc_number: 'DN-CW-TR-2026-0001', version: 2, ext: 'PDF' })).toBe('CW-DN_TRI-0012_DN-CW-TR-2026-0001_v2.pdf');
  });
  it('has no number segment when the document was not generated', () => {
    expect(archiveName({ doc_code: 'CW-DN', site_code: 'TRI-0012', doc_number: null, version: 1, ext: 'jpg' })).toBe('CW-DN_TRI-0012_v1.jpg');
  });
  it('keeps every part safe for a header and any file system', () => {
    expect(archiveName({ doc_code: 'A/B', site_code: '../x y', doc_number: 'N 1', version: 1, ext: 'p.d f' })).toBe('A-B_x-y_N-1_v1.pdf');
  });
});
