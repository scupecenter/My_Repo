import { describe, expect, it } from 'vitest';
import { copyableData, recordName } from './recordTemplate';

const def = { fields: [
  { code: 'remark', type: 'text', label_en: 'Remark' }, { code: 'qty', type: 'number', label_en: 'Qty' }, { code: 'due', type: 'date', label_en: 'Due' },
  { code: 'owner', type: 'user', label_en: 'Owner' }, { code: 'urgent', type: 'yes_no', label_en: 'Urgent' }, { code: 'ro', type: 'text', label_en: 'Ro', read_only: true },
  { code: 'lk', type: 'text', label_en: 'Lk', locked: true }, { code: 'tags', type: 'multi_list', label_en: 'Tags' },
] } as never;

describe('record templates', () => {
  it('keeps plain values of editable fields only', () => {
    const d = copyableData(def, { remark: 'Spares', qty: 4, due: '2026-12-01', owner: 'u1', urgent: false, ro: 'x', lk: 'y', tags: ['a', 'b'], unknown: 1 });
    expect(d).toEqual({ remark: 'Spares', qty: 4, urgent: false, tags: ['a', 'b'] });
  });
  it('names a record by its site and first text', () => {
    expect(recordName(def, { id: 'abcdef123', site_code: 'S1', data: { remark: ' Spares ' } } as never)).toBe('S1 · Spares');
    expect(recordName(def, { id: 'abcdef123', data: {} } as never)).toBe('abcdef12');
  });
});
