import type { NotificationThresholds } from '@/api/types';

/** Ranges from NotificationThresholds in contracts/openapi.yaml v0.2.5. */
export const LIMITS: Record<keyof NotificationThresholds, [number, number]> = {
  approval_remind_hours: [4, 168], approval_escalate_days: [1, 30], sla_warning_days_before_max: [0, 30], rate_cap_per_hour: [5, 500], retention_days: [30, 730],
};
export const RETENTION_MIN = { system_log_days: 90, security_log_days: 365 } as const;

/** Client-side mirror of the server rules; keys are JSON-pointer paths as in the 422 `errors[]`. */
export function thresholdErrors(t: Record<keyof NotificationThresholds, number | ''>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = t[k as keyof NotificationThresholds];
    if (v === '' || !Number.isInteger(v) || v < lo || v > hi) out[`/thresholds/${k}`] = 'out_of_range';
  }
  const r = t.approval_remind_hours, e = t.approval_escalate_days;
  if (!out['/thresholds/approval_remind_hours'] && !out['/thresholds/approval_escalate_days'] && Number(e) * 24 <= Number(r)) {
    out['/thresholds/approval_escalate_days'] = out['/thresholds/approval_remind_hours'] = 'must_exceed_remind_hours';
  }
  return out;
}

/** Lock rule: mandatory types and every security type cannot be switched off. */
export const isLocked = (d: { mandatory: boolean; category: string }) => d.mandatory || d.category === 'security';

export type RetentionIn = { system_log_days: number; security_log_days: number };
export const retentionErrors = (v: RetentionIn) => ({
  ...(!Number.isInteger(v.system_log_days) || v.system_log_days < RETENTION_MIN.system_log_days || v.system_log_days > 3650 ? { '/system_log_days': 'below_minimum' } : {}),
  ...(!Number.isInteger(v.security_log_days) || v.security_log_days < RETENTION_MIN.security_log_days || v.security_log_days > 3650 ? { '/security_log_days': 'below_minimum' } : {}),
});
export const isReduction = (cur: RetentionIn, next: RetentionIn) => next.system_log_days < cur.system_log_days || next.security_log_days < cur.security_log_days;
