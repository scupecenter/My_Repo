/**
 * Capture date of a photo from its EXIF block (DateTimeOriginal, then CreateDate, then DateTime). JPEG, TIFF and HEIC are read; null when there is
 * no date (the photo is then accepted and flagged "unknown capture date" for the reviewer, CLAUDE.md "QC photo requirements").
 * The EXIF text has no time zone: it is read as written and returned as that wall-clock time in UTC.
 */
function readTiffDate(b: Buffer, t: number): Date | null {
  if (t < 0 || t + 8 > b.length) return null;
  const little = b.toString('latin1', t, t + 2) === 'II';
  if (!little && b.toString('latin1', t, t + 2) !== 'MM') return null;
  const u16 = (o: number): number => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number): number => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(t + 2) !== 42) return null;
  const readAscii = (entry: number): string | null => {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    if (type !== 2 || count < 19 || count > 64) return null;
    const off = count <= 4 ? entry + 8 : t + u32(entry + 8);
    if (off < 0 || off + count > b.length) return null;
    return b.toString('latin1', off, off + count - 1);
  };
  const walk = (ifd: number, wanted: number[]): { found: Map<number, string>; exif: number | null } => {
    const found = new Map<number, string>();
    let exif: number | null = null;
    const at = t + ifd;
    if (at < 0 || at + 2 > b.length) return { found, exif };
    const n = Math.min(u16(at), 200);
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = u16(e);
      if (tag === 0x8769) exif = u32(e + 8);
      else if (wanted.includes(tag)) {
        const v = readAscii(e);
        if (v) found.set(tag, v);
      }
    }
    return { found, exif };
  };
  const ifd0 = walk(u32(t + 4), [0x0132]);
  let text: string | undefined;
  if (ifd0.exif !== null) {
    const ex = walk(ifd0.exif, [0x9003, 0x9004]);
    text = ex.found.get(0x9003) ?? ex.found.get(0x9004);
  }
  text = text ?? ifd0.found.get(0x0132);
  const m = text ? /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function readExifDate(data: Buffer): Date | null {
  try {
    if (data[0] === 0xff && data[1] === 0xd8) {
      let p = 2;
      while (p + 4 < data.length && data[p] === 0xff) {
        const marker = data[p + 1] as number;
        if (marker === 0xda || marker === 0xd9) break;
        const len = data.readUInt16BE(p + 2);
        if (marker === 0xe1 && data.toString('latin1', p + 4, p + 10) === 'Exif\0\0') return readTiffDate(data, p + 10);
        p += 2 + len;
      }
      return null;
    }
    if (data.toString('latin1', 0, 2) === 'II' || data.toString('latin1', 0, 2) === 'MM') return readTiffDate(data, 0);
    if (data.toString('latin1', 4, 8) === 'ftyp') {
      // HEIC: the Exif item starts with a 4-byte offset, then the TIFF header. Look for the Exif marker, then a TIFF header just after it.
      const head = data.subarray(0, Math.min(data.length, 2 * 1024 * 1024));
      const marker = head.indexOf('Exif\0\0');
      const from = marker >= 0 ? marker + 6 : 0;
      for (const sig of ['MM\0*', 'II*\0']) {
        const i = head.indexOf(Buffer.from(sig, 'latin1'), from);
        if (i >= 0) {
          const d = readTiffDate(data, i);
          if (d) return d;
        }
      }
    }
  } catch {
    /* a damaged EXIF block is no date */
  }
  return null;
}

/**
 * EXIF DateTimeOriginal has no time zone: readExifDate gives the camera's wall clock as if it were UTC. Q232 (migration 0056): that wall clock is
 * read in the project's time zone (Africa/Tripoli), so it compares correctly with the raise time of a snag.
 */
export function exifWallToInstant(wall: Date, timeZone = 'Africa/Tripoli'): Date {
  const offsetAt = (at: Date): number => {
    const parts: Record<string, number> = {};
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at)) {
      if (p.type !== 'literal') parts[p.type] = Number(p.value);
    }
    const asUtc = Date.UTC(parts.year as number, (parts.month as number) - 1, parts.day as number, parts.hour as number, parts.minute as number, parts.second as number);
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
  };
  // two passes: the offset at the guessed instant, so a change of offset near the wall time is taken into account
  let t = wall.getTime() - offsetAt(wall);
  t = wall.getTime() - offsetAt(new Date(t));
  return new Date(t);
}
