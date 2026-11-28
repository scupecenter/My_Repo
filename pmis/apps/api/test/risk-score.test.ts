import { describe, expect, it } from 'vitest';
import { withRiskScore } from '../src/registers/registers.service';

describe('A2 risk score and level (derived on read)', () => {
  it('is probability x impact with the band of the risk matrix', () => {
    expect(withRiskScore({ probability: 1, impact: 3 })).toMatchObject({ risk_score: 3, risk_level: 'low' });
    expect(withRiskScore({ probability: 2, impact: 4 })).toMatchObject({ risk_score: 8, risk_level: 'medium' });
    expect(withRiskScore({ probability: 4, impact: 4 })).toMatchObject({ risk_score: 16, risk_level: 'high' });
    expect(withRiskScore({ probability: 5, impact: 5 })).toMatchObject({ risk_score: 25, risk_level: 'critical' });
  });
  it('accepts numbers stored as text and keeps the other values', () => {
    expect(withRiskScore({ probability: '3', impact: '3', risk_id: 'R1' })).toEqual({ probability: '3', impact: '3', risk_id: 'R1', risk_score: 9, risk_level: 'medium' });
  });
  it('shows neither when probability or impact is missing or out of range', () => {
    expect(withRiskScore({ probability: 3 })).toEqual({ probability: 3 });
    expect(withRiskScore({ probability: 0, impact: 9 })).toEqual({ probability: 0, impact: 9 });
  });
});
