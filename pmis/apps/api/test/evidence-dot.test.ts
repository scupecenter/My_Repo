import { describe, expect, it } from 'vitest';
import { evidenceDot } from '../src/site-master/site-master.service';

/** The evidence dot of a Site Master cell (contract 0.15.83): red = upload needed, yellow = uploaded but not all approved, green = all approved, none = no document required. */
describe('evidenceDot', () => {
  const c = (o: Partial<{ need: number; missing: number; rejected: number; expired: number; pending: number }>) => ({ need: 3, missing: 0, rejected: 0, expired: 0, pending: 0, ...o });
  it('has no dot when nothing is required', () => expect(evidenceDot(c({ need: 0 }))).toBeUndefined());
  it('is green only when every mandatory document is approved', () => expect(evidenceDot(c({}))).toMatchObject({ state: 'green', approved: 3 }));
  it('is yellow when all are uploaded but some wait for review', () => expect(evidenceDot(c({ pending: 2 }))).toMatchObject({ state: 'yellow', approved: 1, pending: 2 }));
  it('is red when one is missing, rejected or expired', () => {
    expect(evidenceDot(c({ missing: 1, pending: 1 }))?.state).toBe('red');
    expect(evidenceDot(c({ rejected: 1 }))?.state).toBe('red');
    expect(evidenceDot(c({ expired: 1 }))?.state).toBe('red');
  });
});
