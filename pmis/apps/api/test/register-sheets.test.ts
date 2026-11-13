import { describe, expect, it } from 'vitest';
import { isPersonal, loadRegisterMaps, normaliseValue, parseDateText } from '../src/master-import/register-sheets';

/** Migration 0093: the shipped register maps (one source of truth with tools/master-import) and the mechanical normalisation. No database. */
describe('register sheets of the legacy Master (0093)', () => {
  it('ships the eight register maps, with the personal columns marked', () => {
    const maps = loadRegisterMaps();
    expect(maps.map((m) => m.template_id).sort()).toEqual(['TPL-ACQ', 'TPL-ASB', 'TPL-GECOL', 'TPL-HLC', 'TPL-PO', 'TPL-PRM', 'TPL-RF', 'TPL-RSK']);
    expect(maps.find((m) => m.register === 'risks')!.site_scoped).toBe(false);
    const acq = maps.find((m) => m.register === 'acquisition')!;
    for (const h of ['Owner / Landlord', 'Contact Person', 'Phone', 'E-mail']) expect(isPersonal(acq.columns.find((c) => c.template_header === h)!)).toBe(true);
    expect(isPersonal(acq.columns.find((c) => c.template_header === 'Candidate')!)).toBe(false);
    expect(maps.find((m) => m.register === 'as_built')!.columns.find((c) => c.template_header === 'Record Type')!.transform).toBe('const:te_part');
  });

  it('reads dates typed as text, day first when ambiguous', () => {
    expect(parseDateText('2026-03-05')).toEqual({ date: '2026-03-05', assumed: false });
    expect(parseDateText('13/04/2026')).toEqual({ date: '2026-04-13', assumed: false });
    expect(parseDateText('05/03/2026')).toEqual({ date: '2026-03-05', assumed: true });
    expect(parseDateText('5-Mar-2026')).toEqual({ date: '2026-03-05', assumed: false });
    expect(parseDateText('31/02/2026').date).toBeNull();
    expect(parseDateText('soon').date).toBeNull();
  });

  it('normalises mechanically and passes the rest as found', () => {
    const date = { code: 'd', kind: 'field', type: 'date', header: 'D' };
    const num = { code: 'n', kind: 'field', type: 'number', header: 'N' };
    const list = { code: 'l', kind: 'field', type: 'list', header: 'L', options: ['Yes', 'No', 'N/A'] };
    const yn = { code: 'y', kind: 'field', type: 'yes_no', header: 'Y' };
    expect(normaliseValue('N/A', date)).toEqual({});
    expect(normaliseValue('Pending', num)).toEqual({});
    expect(normaliseValue(46000, date)).toEqual({ value: '2025-12-09' });
    expect(normaliseValue(' 12.5 ', num)).toEqual({ value: 12.5 });
    expect(normaliseValue('twelve', num)).toEqual({ value: 'twelve', note: 'not_normalised' });
    expect(normaliseValue('yes', list)).toEqual({ value: 'Yes' });
    expect(normaliseValue('y', list)).toEqual({ value: 'Yes' });
    expect(normaliseValue('Maybe', list)).toEqual({ value: 'Maybe', note: 'outside_list' });
    expect(normaliseValue('No', yn)).toEqual({ value: false });
    expect(normaliseValue('  two   spaces ', { code: 't', kind: 'field', type: 'text', header: 'T' })).toEqual({ value: 'two spaces' });
  });
});
