// A small JPEG builder for the Media geotag tests: an Exif block with a make and a GPS point, an optional XMP block and the pixel size.
/** SOI, an Exif APP1 (little-endian TIFF with Make and a GPS block), an optional XMP APP1, a SOF0 with the size, then SOS. */
function rat(n: number, d: number): Buffer { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32LE(d, 4); return b; }
export function exif(o: { make?: string; lat?: [number, number, number, string]; lon?: [number, number, number, string]; alt?: number; below?: boolean }): Buffer {
  // IFD0: Make (0x010F, ascii), GPS pointer (0x8825). GPS IFD: 1 LatRef, 2 Lat, 3 LonRef, 4 Lon, 5 AltRef, 6 Alt.
  const make = Buffer.from(`${o.make ?? ''}\0`, 'latin1');
  const inline = make.length <= 4; // a value of four bytes or less sits in the entry itself
  const ifd0Entries = (o.make ? 1 : 0) + 1;
  const ifd0Len = 2 + ifd0Entries * 12 + 4;
  const makeAt = 8 + ifd0Len;
  const gpsAt = makeAt + (o.make && !inline ? make.length + (make.length % 2) : 0);
  const gEntries = (o.lat ? 2 : 0) + (o.lon ? 2 : 0) + (o.alt !== undefined ? 2 : 0);
  const gLen = 2 + gEntries * 12 + 4;
  let dataAt = gpsAt + gLen;
  const data: Buffer[] = [];
  const entry = (tag: number, type: number, count: number, val: Buffer | number): Buffer => {
    const e = Buffer.alloc(12); e.writeUInt16LE(tag, 0); e.writeUInt16LE(type, 2); e.writeUInt32LE(count, 4);
    if (typeof val === 'number') e.writeUInt32LE(val, 8); else val.copy(e, 8);
    return e;
  };
  const dmsEntry = (tag: number, v: [number, number, number, string]): Buffer => {
    const at = dataAt; data.push(Buffer.concat([rat(v[0], 1), rat(v[1], 1), rat(v[2], 100)])); dataAt += 24; return entry(tag, 5, 3, at);
  };
  const ref = (tag: number, s: string): Buffer => entry(tag, 2, 2, Buffer.from(`${s}\0\0\0`, 'latin1'));
  const g: Buffer[] = [];
  if (o.lat) { g.push(ref(1, o.lat[3]), dmsEntry(2, o.lat)); }
  if (o.lon) { g.push(ref(3, o.lon[3]), dmsEntry(4, o.lon)); }
  if (o.alt !== undefined) { g.push(entry(5, 1, 1, Buffer.from([o.below ? 1 : 0, 0, 0, 0]))); const at = dataAt; data.push(rat(Math.round(o.alt * 10), 10)); dataAt += 8; g.push(entry(6, 5, 1, at)); }
  const head = Buffer.alloc(8); head.write('II', 0, 'latin1'); head.writeUInt16LE(42, 2); head.writeUInt32LE(8, 4);
  const n0 = Buffer.alloc(2); n0.writeUInt16LE(ifd0Entries, 0);
  const ifd0 = Buffer.concat([n0, ...(o.make ? [entry(0x010f, 2, make.length, inline ? Buffer.concat([make, Buffer.alloc(4 - make.length)]) : makeAt)] : []), entry(0x8825, 4, 1, gpsAt), Buffer.alloc(4)]);
  const ng = Buffer.alloc(2); ng.writeUInt16LE(gEntries, 0);
  const tiff = Buffer.concat([head, ifd0, ...(o.make && !inline ? [make, Buffer.alloc(make.length % 2)] : []), ng, ...g, Buffer.alloc(4), ...data]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4); seg.writeUInt16BE(0xffe1, 0); seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([seg, body]);
}
export function jpeg(parts: { exif?: Buffer; xmp?: string; w?: number; h?: number }): Buffer {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (parts.exif) out.push(parts.exif);
  if (parts.xmp) { const body = Buffer.from(`http://ns.adobe.com/xap/1.0/\0${parts.xmp}`, 'utf8'); const s = Buffer.alloc(4); s.writeUInt16BE(0xffe1, 0); s.writeUInt16BE(body.length + 2, 2); out.push(s, body); }
  const sof = Buffer.alloc(19); sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(parts.h ?? 100, 5); sof.writeUInt16BE(parts.w ?? 200, 7); sof[9] = 3;
  out.push(sof, Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(16));
  return Buffer.concat(out);
}
