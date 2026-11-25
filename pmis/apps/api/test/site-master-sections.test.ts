import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBands,
  buildMenu,
  buildSiteMaster,
  colLetterToOrd,
  defaultSectionsByOrd,
  menuColumns,
  SITE_MASTER_MENUS,
  SITE_MASTER_DEFAULT_RANGES,
  type SiteMasterColumnRow,
  type SiteMasterSection,
} from '../src/site-master/site-master-sections';

// The Master layout as the migration seeds it: 187 columns, bands from the Master sheet row 1.
function masterColumns(): SiteMasterColumnRow[] {
  const sec = defaultSectionsByOrd();
  const band = (o: number): string => {
    if (o === 1) return '#';
    if (o <= 22) return 'RF & DESIGN';
    if (o === 23 || o === 50 || o === 69 || o === 79 || o === 100 || o === 121 || o === 143 || o === 150 || o === 156) return 'Phase Gate';
    if (o <= 49) return 'PRE-CW';
    if (o <= 78) return 'ACTUAL CW';
    if (o <= 99) return 'TE INSTALLATION';
    if (o <= 120) return 'ON-AIR';
    if (o <= 142) return 'TE PAC';
    if (o <= 149) return 'CLUSTER OPTIMIZATION';
    if (o <= 155) return 'HOTO';
    if (o <= 168) return 'FINAL CLOSURE';
    if (o <= 178) return 'DISMANTLE';
    return 'STATUS';
  };
  const out: SiteMasterColumnRow[] = [];
  for (let o = 1; o <= 187; o++) {
    const letters = (n: number): string => {
      let s = '';
      for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(64 + ((x - 1) % 26) + 1) + s;
      return s;
    };
    out.push({
      ord: o,
      letter: letters(o),
      group_top: band(o),
      group_mid: o <= 2 ? 'Identification' : o === 4 ? 'Identification' : `group ${Math.ceil(o / 10)}`,
      header: `field ${o}`,
      sections: sec.get(o)!,
    });
  }
  return out;
}

describe('Site Master default sections', () => {
  it('gives every Master column its default menu', () => {
    const m = defaultSectionsByOrd();
    expect(m.size).toBe(187);
    for (let o = 1; o <= 187; o++) expect(m.get(o)).toHaveLength(1);
  });

  it('keeps the ranges contiguous and without overlap', () => {
    const seen = new Set<number>();
    for (const [from, to] of SITE_MASTER_DEFAULT_RANGES) {
      expect(from).toBeLessThanOrEqual(to);
      for (let o = from; o <= to; o++) {
        expect(seen.has(o)).toBe(false);
        seen.add(o);
      }
    }
    expect(seen.size).toBe(187);
  });

  it('matches the ranges seeded by migration 0101', () => {
    const sql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '0101_site_master_sections', 'migration.sql'), 'utf8');
    const seeded = [...sql.matchAll(/WHEN ord BETWEEN (\d+) AND (\d+) THEN '(\w+)'/g)].map((m) => [Number(m[1]), Number(m[2]), m[3]]);
    expect(seeded).toEqual(SITE_MASTER_DEFAULT_RANGES.map(([a, b, s]) => [a, b, s]));
  });

  it('reads Master letters as column orders', () => {
    expect(colLetterToOrd('A')).toBe(1);
    expect(colLetterToOrd('Z')).toBe(26);
    expect(colLetterToOrd('AA')).toBe(27);
    expect(colLetterToOrd('AX')).toBe(50);
    expect(colLetterToOrd('EZ')).toBe(156);
    expect(colLetterToOrd('FM')).toBe(169);
    expect(colLetterToOrd('GE')).toBe(187);
    expect(() => colLetterToOrd('a1')).toThrow();
  });
});

describe('Site Master menu columns', () => {
  const cols = masterColumns();

  it('lists all 187 columns in Master, and the seven menus plus Master in order', () => {
    expect(menuColumns('master', cols)).toHaveLength(187);
    expect(buildSiteMaster(cols).map((m) => m.key)).toEqual(SITE_MASTER_MENUS.map((m) => m.key));
  });

  it('gives the CW menu W and AG:BY, with the SOW columns X:AF left to their own menu', () => {
    const ords = menuColumns('cw', cols).map((c) => c.ord);
    expect(ords).toEqual(expect.arrayContaining([23, 33, 50, 77]));
    for (const o of [24, 28, 32]) expect(ords).not.toContain(o);
    for (const o of [78, 150]) expect(ords).not.toContain(o);
  });

  it('shows the status columns and the identity columns in every menu', () => {
    for (const m of SITE_MASTER_MENUS) {
      const ords = menuColumns(m.key, cols).map((c) => c.ord);
      for (const o of [1, 2, 4, 180, 187]) expect(ords).toContain(o);
    }
  });

  it('freezes # to Site Name by default in every menu', () => {
    for (const m of buildSiteMaster(cols)) expect(m.frozen_ords).toEqual([1, 2, 3, 4]);
  });

  it('gives the SOW menu X to AF', () => {
    const sow = buildMenu('sow', cols);
    expect(sow.columns.filter((c) => c.sections.includes('sow')).map((c) => c.letter)).toEqual(['X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF']);
  });
});

describe('Site Master grid header', () => {
  it('builds phase band, group and field, merging runs of the same band and group', () => {
    const cols: SiteMasterColumnRow[] = [
      { ord: 1, letter: 'A', group_top: 'PRE-CW', group_mid: 'G1', header: 'a', sections: ['cw'] },
      { ord: 2, letter: 'B', group_top: 'PRE-CW', group_mid: 'G1', header: 'b', sections: ['cw'] },
      { ord: 3, letter: 'C', group_top: 'PRE-CW', group_mid: 'G2', header: 'c', sections: ['cw'] },
      { ord: 4, letter: 'D', group_top: 'Phase Gate', group_mid: 'Readiness', header: 'd', sections: ['cw'] },
    ];
    const bands = buildBands(cols);
    expect(bands).toHaveLength(2);
    expect(bands[0]).toEqual({
      name: 'PRE-CW',
      is_phase_gate: false,
      groups: [
        { name: 'G1', ords: [1, 2] },
        { name: 'G2', ords: [3] },
      ],
    });
    expect(bands[1]!.is_phase_gate).toBe(true);
  });

  it('flags the Phase Gate columns of a menu', () => {
    const m = buildMenu('cw', masterColumns());
    expect(m.columns.find((c) => c.letter === 'W')!.is_phase_gate).toBe(true);
    expect(m.columns.find((c) => c.letter === 'X')).toBeUndefined();
  });

  it('builds an empty header for a menu with no section columns but keeps the status band', () => {
    const cols = masterColumns().map((c) => ({ ...c, sections: ['design_acq'] as SiteMasterSection[] }));
    const dismantle = buildMenu('dismantle', cols);
    expect(dismantle.columns.every((c) => c.sections.includes('design_acq') || c.sections.includes('status') || c.ord <= 4)).toBe(true);
    expect(dismantle.bands.length).toBeGreaterThan(0);
  });
});

describe('Site Master column in several menus', () => {
  it('shows a column with HOTO and O&M in both menus', () => {
    const cols = masterColumns().map((c) => (c.ord === 150 ? { ...c, sections: ['hoto', 'om'] as SiteMasterSection[] } : c));
    expect(menuColumns('hoto', cols).map((c) => c.ord)).toContain(150);
    expect(menuColumns('om', cols).map((c) => c.ord)).toContain(150);
    expect(menuColumns('cw', cols).map((c) => c.ord)).not.toContain(150);
  });
});
