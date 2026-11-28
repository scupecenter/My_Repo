import { describe, expect, it } from 'vitest';
import { distanceM, readMediaGeo, type GeoCfg } from '../src/media/geo';
import { exif, jpeg } from './geo-fixtures';

const cfg: GeoCfg = { panorama: true, panorama_min_ratio: 2, panorama_min_width_px: 3000, drone_makes: ['DJI', 'Autel'] };

describe('readMediaGeo (Media geotag)', () => {
  it('reads the point, the altitude and the pixel size of a JPEG, with the hemisphere signs', () => {
    const m = readMediaGeo(jpeg({ exif: exif({ make: 'Canon', lat: [32, 53, 2400, 'N'], lon: [13, 11, 1200, 'E'], alt: 21.5 }), w: 4000, h: 3000 }), 'image/jpeg', cfg);
    expect(m.source).toBe('exif');
    expect(m.lat).toBeCloseTo(32 + 53 / 60 + 24 / 3600, 5);
    expect(m.lon).toBeCloseTo(13 + 11 / 60 + 12 / 3600, 5);
    expect(m.alt_m).toBe(21.5);
    expect([m.width_px, m.height_px, m.make, m.media_kind]).toEqual([4000, 3000, 'Canon', 'photo']);
    const s = readMediaGeo(jpeg({ exif: exif({ lat: [10, 0, 0, 'S'], lon: [20, 0, 0, 'W'], alt: 5, below: true }) }), 'image/jpeg', cfg);
    expect([s.lat, s.lon, s.alt_m]).toEqual([-10, -20, -5]);
  });

  it('answers empty for a photo without a point, for a zero point and for bytes that are not an image', () => {
    expect(readMediaGeo(jpeg({ exif: exif({ make: 'Canon' }) }), 'image/jpeg', cfg)).toMatchObject({ lat: null, lon: null, source: 'none' });
    expect(readMediaGeo(jpeg({ exif: exif({ lat: [0, 0, 0, 'N'], lon: [0, 0, 0, 'E'] }) }), 'image/jpeg', cfg).source).toBe('none');
    expect(readMediaGeo(Buffer.from('not an image at all, plain text'), 'image/jpeg', cfg)).toMatchObject({ source: 'none', media_kind: 'photo' });
    expect(readMediaGeo(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]), 'image/jpeg', cfg).source).toBe('none');
  });

  it('marks a panorama by its projection tag or its shape, and a drone by its maker or its XMP block', () => {
    const tagged = readMediaGeo(jpeg({ xmp: '<x GPano:ProjectionType="equirectangular"/>', w: 1000, h: 800 }), 'image/jpeg', cfg);
    expect(tagged.media_kind).toBe('panorama');
    const wide = readMediaGeo(jpeg({ w: 8000, h: 4000 }), 'image/jpeg', cfg);
    expect(wide.media_kind).toBe('panorama');
    expect(readMediaGeo(jpeg({ w: 8000, h: 6000 }), 'image/jpeg', cfg).media_kind).toBe('photo');
    expect(readMediaGeo(jpeg({ w: 8000, h: 4000 }), 'image/jpeg', { ...cfg, panorama: false }).media_kind).toBe('photo');
    expect(readMediaGeo(jpeg({ exif: exif({ make: 'DJI', lat: [32, 0, 0, 'N'], lon: [13, 0, 0, 'E'] }) }), 'image/jpeg', cfg).media_kind).toBe('drone');
    expect(readMediaGeo(jpeg({ exif: exif({ make: 'dji' }) }), 'image/jpeg', cfg).media_kind).toBe('drone');
    expect(readMediaGeo(jpeg({ xmp: '<x xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"/>' }), 'image/jpeg', cfg).media_kind).toBe('drone');
    expect(readMediaGeo(jpeg({ exif: exif({ make: 'DJI' }) }), 'image/jpeg', { ...cfg, drone_makes: [] }).media_kind).toBe('photo');
  });

  it('takes the point from the drone XMP when the EXIF has none, and the size of a PNG', () => {
    const d = readMediaGeo(jpeg({ xmp: '<x drone-dji:GpsLatitude="+32.5" drone-dji:GpsLongitude="+13.25" drone-dji:AbsoluteAltitude="+88.4"/>' }), 'image/jpeg', cfg);
    expect([d.lat, d.lon, d.alt_m, d.source]).toEqual([32.5, 13.25, 88.4, 'exif']);
    const png = Buffer.alloc(40); png.write('\x89PNG\r\n\x1a\n', 0, 'latin1'); png.writeUInt32BE(6000, 16); png.writeUInt32BE(3000, 20);
    expect(readMediaGeo(png, 'image/png', cfg)).toMatchObject({ width_px: 6000, height_px: 3000, media_kind: 'panorama', source: 'none' });
  });

  it('measures metres between two points', () => {
    expect(distanceM(32.9, 13.18, 32.9, 13.18)).toBe(0);
    const d = distanceM(32.9, 13.18, 32.91, 13.18);
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });
});
