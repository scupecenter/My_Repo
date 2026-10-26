import { describe, expect, it } from 'vitest';
import type { Me } from '@/api/types';
import { validatePolicy } from '@/mocks/handlers.settings';
import { CATALOGUE } from '@/mocks/settingsData';
import { hasGrant } from './perm';
import { isLocked, isReduction, LIMITS, retentionErrors, thresholdErrors } from './policy';
import { weightIssues } from './weights';

const th = { approval_remind_hours: 48, approval_escalate_days: 5, sla_warning_days_before_max: 2, rate_cap_per_hour: 50, retention_days: 180 };
const act = (code: string, weight: number, items: number[] = []) => ({ code, name_en: code, weight, items: items.map((w, i) => ({ code: `${code}${i}`, name_en: 'i', weight: w })) });

describe('weights', () => {
  it('accepts 100% at every level', () => expect(weightIssues({ activities: [act('a', 60, [50, 50]), act('b', 40)] })).toEqual([]));
  it('reports the activity level and the failing item level separately', () => {
    expect(weightIssues({ activities: [act('a', 50, [70, 20]), act('b', 40)] })).toEqual([{ level: 'activities', sum: 90 }, { level: 'items', activity: 'a', sum: 90 }]);
  });
  it('tolerates float noise', () => expect(weightIssues({ activities: [act('a', 33.3), act('b', 33.3), act('c', 33.4)] })).toEqual([]));
});

describe('notification thresholds', () => {
  it('has the contract ranges', () => expect(LIMITS.approval_remind_hours).toEqual([4, 168]));
  it('passes the defaults', () => expect(thresholdErrors(th)).toEqual({}));
  it('flags an out-of-range value', () => expect(thresholdErrors({ ...th, rate_cap_per_hour: 4 })['/thresholds/rate_cap_per_hour']).toBe('out_of_range'));
  it('enforces escalate*24 > remind on both paths', () => {
    const e = thresholdErrors({ ...th, approval_remind_hours: 120, approval_escalate_days: 5 });
    expect(e['/thresholds/approval_escalate_days']).toBe('must_exceed_remind_hours');
    expect(e['/thresholds/approval_remind_hours']).toBe('must_exceed_remind_hours');
    expect(thresholdErrors({ ...th, approval_remind_hours: 119, approval_escalate_days: 5 })).toEqual({});
  });
  it('locks mandatory and security types', () => {
    expect(isLocked({ mandatory: false, category: 'security' })).toBe(true);
    expect(isLocked({ mandatory: true, category: 'approvals' })).toBe(true);
    expect(isLocked({ mandatory: false, category: 'approvals' })).toBe(false);
  });
});

describe('server-side policy validation (mock mirrors the contract)', () => {
  const ok = { reason: 'r', enabled: true, timezone: 'Africa/Tripoli', digest_hour: 8, work_days_follow_calendar: true, thresholds: th, matrix: [] };
  it('rejects unknown keys, bad timezone and the cross-field rule', () => {
    const e = validatePolicy({ ...ok, bogus: 1, timezone: 'Mars/Base', thresholds: { ...th, approval_remind_hours: 168, approval_escalate_days: 3 } } as never);
    expect(e).toContainEqual({ path: '/bogus', code: 'unknown_key' });
    expect(e).toContainEqual({ path: '/timezone', code: 'invalid_timezone' });
    expect(e.filter((x) => x.code === 'must_exceed_remind_hours')).toHaveLength(2);
  });
  it('refuses to switch off a mandatory type or any security type', () => {
    const sec = CATALOGUE.find((c) => c.category === 'security')!;
    const e = validatePolicy({ ...ok, matrix: [{ type_code: sec.code, channels: { in_app: false, email: false }, cells: [{ kind: 'group', id: 'g', on: false }] }] } as never);
    expect(e.some((x) => x.code === 'mandatory_locked')).toBe(true);
  });
});

describe('retention', () => {
  it('enforces minimums 90 and 365', () => {
    expect(retentionErrors({ system_log_days: 89, security_log_days: 364 })).toEqual({ '/system_log_days': 'below_minimum', '/security_log_days': 'below_minimum' });
    expect(retentionErrors({ system_log_days: 90, security_log_days: 365 })).toEqual({});
  });
  it('detects a reduction', () => {
    const cur = { system_log_days: 365, security_log_days: 730 };
    expect(isReduction(cur, { ...cur, security_log_days: 400 })).toBe(true);
    expect(isReduction(cur, { system_log_days: 400, security_log_days: 730 })).toBe(false);
  });
});

describe('grants', () => {
  const me = (admin: boolean, actions: string[]) => ({ is_system_admin: admin, effective: { grants: actions.map((a) => ({ module_key: 'x', action: a, region_ids: 'all' })), nav: [] } }) as unknown as Me;
  it('System Admin has every grant', () => expect(hasGrant(me(true, []), 'manage_users')).toBe(true));
  it('others need the grant', () => {
    expect(hasGrant(me(false, ['view_security_log']), 'view_security_log')).toBe(true);
    expect(hasGrant(me(false, ['view_security_log']), 'manage_users')).toBe(false);
    expect(hasGrant(undefined, 'manage_users')).toBe(false);
  });
});
