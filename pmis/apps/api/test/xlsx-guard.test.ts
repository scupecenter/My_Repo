import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { guardXlsx, MAX_UNCOMPRESSED_BYTES } from '../src/templates/xlsx-guard';

/** A minimal zip (deflate) whose declared sizes can be forged, to test the guard without a real workbook. */
function zip(entries: { name: string; data: Buffer; declared?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const comp = deflateRawSync(e.data);
    const size = e.declared ?? e.data.length;
    const name = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const base = [
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
];

describe('xlsx guard (zip bomb)', () => {
  it('accepts a small honest package', () => {
    expect(guardXlsx('a.xlsx', zip(base))).toEqual({ ok: true });
  });

  it('refuses an entry that inflates past the budget although it declares a tiny size', () => {
    const bomb = { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(MAX_UNCOMPRESSED_BYTES + 1024 * 1024), declared: 1000 };
    expect(guardXlsx('a.xlsx', zip([...base, bomb]))).toMatchObject({ ok: false, reason: 'size_or_rows_exceeded' });
  });

  it('refuses an entry whose real size differs from the declared one', () => {
    const liar = { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(5000), declared: 10 };
    expect(guardXlsx('a.xlsx', zip([...base, liar]))).toMatchObject({ ok: false, reason: 'not_xlsx' });
  });
});
