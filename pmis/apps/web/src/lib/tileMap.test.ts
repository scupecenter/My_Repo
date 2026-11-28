import { describe, expect, it } from 'vitest';
import { fitView, isSafeTileTemplate, pan, project, tileUrl, toScreen, unproject, visibleTiles, zoomAt } from './tileMap';

const size = { width: 512, height: 384 };
const tripoli = { lat: 32.8872, lon: 13.1913, zoom: 10 };

describe('tile map maths', () => {
  it('projects and unprojects back to the same place', () => {
    const p = project(32.9, 13.2, 12), q = unproject(p.x, p.y, 12);
    expect(q.lat).toBeCloseTo(32.9, 6);
    expect(q.lon).toBeCloseTo(13.2, 6);
  });
  it('puts the centre of the view in the middle of the box', () => {
    const s = toScreen(tripoli.lat, tripoli.lon, tripoli, size);
    expect(s.x).toBeCloseTo(256, 6);
    expect(s.y).toBeCloseTo(192, 6);
  });
  it('covers the box with tiles, wraps x and skips y outside the world', () => {
    const t = visibleTiles(tripoli, size);
    expect(t.length).toBeGreaterThanOrEqual(6);
    expect(t.every((x) => x.z === 10 && x.x >= 0 && x.x < 1024 && x.y >= 0 && x.y < 1024)).toBe(true);
    const north = visibleTiles({ lat: 85, lon: 179.9, zoom: 2 }, size);
    expect(north.every((x) => x.y >= 0 && x.y < 4 && x.x >= 0 && x.x < 4)).toBe(true);
  });
  it('drags: moving the map right shows places further west', () => {
    const v = pan(tripoli, 100, 0);
    expect(v.lon).toBeLessThan(tripoli.lon);
    expect(v.lat).toBeCloseTo(tripoli.lat, 6);
  });
  it('zooms inside the limits and keeps the place under the pointer', () => {
    expect(zoomAt({ ...tripoli, zoom: 18 }, 1, 0, 18, size).zoom).toBe(18);
    expect(zoomAt({ ...tripoli, zoom: 0 }, -1, 0, 18, size).zoom).toBe(0);
    const v = zoomAt(tripoli, 1, 0, 18, size, 400, 100);
    expect(v.zoom).toBe(11);
    const before = unproject(project(tripoli.lat, tripoli.lon, 10).x + 144, project(tripoli.lat, tripoli.lon, 10).y - 92, 10);
    const after = toScreen(before.lat, before.lon, v, size);
    expect(after.x).toBeCloseTo(400, 4);
    expect(after.y).toBeCloseTo(100, 4);
  });
  it('builds a tile address from the template', () => {
    expect(tileUrl('/tiles/{z}/{x}/{y}.png', { z: 3, x: 4, y: 5 })).toBe('/tiles/3/4/5.png');
  });
  it('accepts only an empty value or a path on this server', () => {
    expect(isSafeTileTemplate('')).toBe(true);
    expect(isSafeTileTemplate('/tiles/{z}/{x}/{y}.png')).toBe(true);
    for (const bad of ['https://t.example/{z}/{x}/{y}.png', '//t.example/{z}/{x}/{y}.png', '/tiles/../{z}/{x}/{y}.png', '/tiles/{z}/{x}.png', 'tiles/{z}/{x}/{y}.png', '/tiles/{z}/{x}/{y}.png?k=1', '/a b/{z}/{x}/{y}'])
      expect(isSafeTileTemplate(bad), bad).toBe(false);
  });
  it('fits the pins: none or one keeps a sensible view, several fit the box', () => {
    const start = { lat: 32.9, lon: 13.2, zoom: 6 };
    expect(fitView([], size, start, 0, 18)).toEqual(start);
    expect(fitView([{ lat: 30, lon: 20 }], size, start, 0, 18)).toMatchObject({ lat: 30, lon: 20, zoom: 12 });
    const pts = [{ lat: 32.9, lon: 13.2 }, { lat: 32.1, lon: 20.07 }];
    const v = fitView(pts, size, start, 0, 18);
    for (const p of pts) {
      const s = toScreen(p.lat, p.lon, v, size);
      expect(s.x).toBeGreaterThan(0); expect(s.x).toBeLessThan(size.width);
      expect(s.y).toBeGreaterThan(0); expect(s.y).toBeLessThan(size.height);
    }
  });
});
