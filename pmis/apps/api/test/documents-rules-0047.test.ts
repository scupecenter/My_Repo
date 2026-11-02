import { describe, expect, it } from 'vitest';
import { evalRule } from '../src/documents/rules';

describe('rule language: the roots of migration 0047 (Q130, Q131)', () => {
  it('reads procurement.delivery (B1), the site custom field near_airport (A3) and a register record (record.data)', () => {
    expect(evalRule({ eq: ['procurement.delivery', 'outsourced'] }, { procurement: { delivery: 'Outsourced' } })).toBe(true);
    expect(evalRule({ eq: ['procurement.delivery', 'outsourced'] }, { procurement: { delivery: 'In-House' } })).toBe(false);
    expect(evalRule({ eq: ['procurement.delivery', 'outsourced'] }, { procurement: {} })).toBeNull();
    expect(evalRule({ is_yes: 'site.custom.near_airport' }, { site: { custom: { near_airport: true } } })).toBe(true);
    expect(evalRule({ is_yes: 'site.custom.near_airport' }, { site: { custom: { near_airport: false } } })).toBe(false);
    expect(evalRule({ in: ['record.data.severity', ['Major', 'Critical']] }, { record: { data: { severity: 'major' } } })).toBe(true);
  });
});
