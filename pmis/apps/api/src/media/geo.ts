/**
 * What a photo says about where and how it was taken (Media geotag, contract 0.15.539): the GPS point of the EXIF block, the altitude, the capture time,
 * the camera make and model, the pixel size, and from those the kind of media: photo, panorama (a 360 degree equirectangular image, by its XMP
 * projection tag or by its shape) or drone (a maker from the setting, or a drone XMP block). Pure functions over the bytes, no dependency: a JPEG is read
 * segment by segment up to the image data, a PNG for its size. A file that cannot be read gives an empty answer, never an error.
 */
export interface GeoCfg { panorama: boolean; panorama_min_ratio: number; panorama_min_width_px: number; drone_makes: string[] }
export type MediaKind = 'photo' | 'panorama' | 'drone';
export interface GeoMeta {
  lat: number | null; lon: number | null; alt_m: number | null; taken_at: string | null; source: 'exif' | 'none';
  media_kind: MediaKind; make: string | null; model: string | null; width_px: number | null; height_px: number | null;
}
const EMPTY: GeoMeta = { lat: null, lon: null, alt_m: null, taken_at: null, source: 'none', media_kind: 'photo', make: null, model: null, width_px: null, height_px: null };

interface Tiff { little: boolean; u16: (o: number) => number; u32: (o: number) => number; at: number; b: Buffer }

function tiffAt(b: Buffer, t: number): Tiff | null {
  if (t < 0 || t + 8 > b.length) return null;
  const mark = b.toString('latin1', t, t + 2);
  if (mark !== 'II' && mark !== 'MM') return null;
  const little = mark === 'II';
  const u16 = (o: number): number => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number): number => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  return u16(t + 2) === 42 ? { little, u16, u32, at: t, b } : null;
}

interface Entry { tag: number; type: number; count: number; valueAt: number }
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function entries(x: Tiff, ifd: number): Entry[] {
  const out: Entry[] = [];
  const at = x.at + ifd;
  if (ifd < 0 || at + 2 > x.b.length) return out;
  const n = Math.min(x.u16(at), 300);
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > x.b.length) break;
    const type = x.u16(e + 2), count = x.u32(e + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const valueAt = size <= 4 ? e + 8 : x.at + x.u32(e + 8);
    if (valueAt < 0 || valueAt + size > x.b.length || count > 4096) continue;
    out.push({ tag: x.u16(e), type, count, valueAt });
  }
  return out;
}
const find = (es: Entry[], tag: number): Entry | undefined => es.find((e) => e.tag === tag);
const ascii = (x: Tiff, e: Entry | undefined): string | null => (e && e.type === 2 ? x.b.toString('latin1', e.valueAt, e.valueAt + e.count).replace(/\0.*$/s, '').trim() || null : null);
const rational = (x: Tiff, e: Entry, i: number): number | null => {
  if (e.type !== 5 && e.type !== 10) return null;
  const o = e.valueAt + i * 8;
  if (o + 8 > x.b.length) return null;
  const den = x.u32(o + 4);
  return den === 0 ? null : x.u32(o) / den;
};
/** Degrees, minutes, seconds (three rationals) to decimal degrees. */
function dms(x: Tiff, e: Entry | undefined): number | null {
  if (!e || e.count < 3) return null;
  const d = rational(x, e, 0), m = rational(x, e, 1), s = rational(x, e, 2);
  return d === null || m === null || s === null ? null : d + m / 60 + s / 3600;
}

interface FromTiff { lat: number | null; lon: number | null; alt: number | null; gpsAt: string | null; make: string | null; model: string | null }
function readTiffGeo(b: Buffer, t: number): FromTiff {
  const out: FromTiff = { lat: null, lon: null, alt: null, gpsAt: null, make: null, model: null };
  const x = tiffAt(b, t);
  if (!x) return out;
  const ifd0 = entries(x, x.u32(t + 4));
  out.make = ascii(x, find(ifd0, 0x010f));
  out.model = ascii(x, find(ifd0, 0x0110));
  const gp = find(ifd0, 0x8825);
  if (!gp) return out;
  const g = entries(x, x.u32(gp.valueAt));
  const la = dms(x, find(g, 2)), lo = dms(x, find(g, 4));
  const latRef = ascii(x, find(g, 1)), lonRef = ascii(x, find(g, 3));
  if (la !== null && lo !== null) {
    out.lat = latRef?.toUpperCase().startsWith('S') ? -la : la;
    out.lon = lonRef?.toUpperCase().startsWith('W') ? -lo : lo;
  }
  const altE = find(g, 6);
  if (altE) {
    const v = rational(x, altE, 0);
    const ref = find(g, 5);
    if (v !== null) out.alt = ref && x.b[ref.valueAt] === 1 ? -v : v;
  }
  const ts = find(g, 7), ds = ascii(x, find(g, 0x1d));
  if (ts && ts.count >= 3 && ds) {
    const h = rational(x, ts, 0), mi = rational(x, ts, 1), s = rational(x, ts, 2);
    const m = /^(\d{4}):(\d{2}):(\d{2})$/.exec(ds);
    if (h !== null && mi !== null && s !== null && m) {
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, Math.floor(s)));
      if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 1990) out.gpsAt = d.toISOString();
    }
  }
  return out;
}

const XMP_HEAD = 'http://ns.adobe.com/xap/1.0/\0';
const xmpValue = (xmp: string, name: string): string | null => {
  const a = new RegExp(`${name}="([^"]*)"`).exec(xmp) ?? new RegExp(`<${name}>([^<]*)<`).exec(xmp);
  return a ? (a[1] as string).trim() : null;
};
const finiteIn = (v: string | null, lo: number, hi: number): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

function readJpeg(b: Buffer, cfg: GeoCfg): GeoMeta {
  let p = 2;
  let tiff: FromTiff = { lat: null, lon: null, alt: null, gpsAt: null, make: null, model: null };
  let xmp = '';
  let w: number | null = null, h: number | null = null;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    const len = b.readUInt16BE(p + 2);
    if (len < 2) break;
    const body = p + 4;
    if (marker === 0xe1 && body + 6 <= b.length && b.toString('latin1', body, body + 6) === 'Exif\0\0') tiff = readTiffGeo(b, body + 6);
    else if (marker === 0xe1 && b.toString('latin1', body, body + XMP_HEAD.length) === XMP_HEAD) xmp = b.toString('utf8', body + XMP_HEAD.length, Math.min(p + 2 + len, b.length));
    else if (marker >= 0xc0 && marker <= 0xc2 && body + 5 <= b.length) { h = b.readUInt16BE(body + 1); w = b.readUInt16BE(body + 3); }
    p += 2 + len;
  }
  return finish(b, tiff, xmp, w, h, cfg);
}

function finish(_b: Buffer, tiff: FromTiff, xmp: string, w: number | null, h: number | null, cfg: GeoCfg): GeoMeta {
  let lat = tiff.lat, lon = tiff.lon, alt = tiff.alt;
  // drone XMP (the maker writes the point there as well, and sometimes only there)
  if ((lat === null || lon === null) && xmp) {
    const xl = finiteIn(xmpValue(xmp, 'drone-dji:GpsLatitude'), -90, 90), xo = finiteIn(xmpValue(xmp, 'drone-dji:GpsLongitude') ?? xmpValue(xmp, 'drone-dji:GpsLongtitude'), -180, 180);
    if (xl !== null && xo !== null) { lat = xl; lon = xo; }
  }
  if (alt === null && xmp) alt = finiteIn(xmpValue(xmp, 'drone-dji:AbsoluteAltitude'), -500, 99999);
  if (lat !== null && lon !== null && (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0))) { lat = null; lon = null; }
  const makeLc = (tiff.make ?? '').toLowerCase();
  const droneByMake = cfg.drone_makes.some((m) => m.trim() !== '' && makeLc.includes(m.trim().toLowerCase()));
  const drone = droneByMake || /xmlns:drone-[a-z]+=/i.test(xmp);
  const pano = cfg.panorama && (/equirectangular/i.test(xmpValue(xmp, 'GPano:ProjectionType') ?? '') || (w !== null && h !== null && h > 0 && w >= cfg.panorama_min_width_px && w / h >= cfg.panorama_min_ratio));
  return {
    lat, lon, alt_m: alt, taken_at: tiff.gpsAt, source: lat !== null && lon !== null ? 'exif' : 'none',
    media_kind: pano ? 'panorama' : drone ? 'drone' : 'photo', make: tiff.make, model: tiff.model, width_px: w, height_px: h,
  };
}

function readPng(b: Buffer, cfg: GeoCfg): GeoMeta {
  const w = b.length >= 24 ? b.readUInt32BE(16) : null, h = b.length >= 24 ? b.readUInt32BE(20) : null;
  return finish(b, { lat: null, lon: null, alt: null, gpsAt: null, make: null, model: null }, '', w, h, cfg);
}

export function readMediaGeo(data: Buffer, mime: string, cfg: GeoCfg): GeoMeta {
  try {
    if (data.length > 12 && data[0] === 0xff && data[1] === 0xd8) return readJpeg(data, cfg);
    if (data.length > 24 && data.toString('latin1', 1, 4) === 'PNG') return readPng(data, cfg);
    if (data.length > 12 && /^image\/(tiff)$/i.test(mime)) {
      const t = readTiffGeo(data, 0);
      return finish(data, t, '', null, null, cfg);
    }
  } catch {
    /* an unreadable block is an empty answer */
  }
  return { ...EMPTY };
}

/** Metres between two points (haversine). The same formula the list query uses to flag a photo far from its site. */
export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number): number => (d * Math.PI) / 180;
  const s = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return Math.round(6371000 * 2 * Math.asin(Math.sqrt(s)));
}
