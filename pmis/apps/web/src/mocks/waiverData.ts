// Synthetic state of the one-time historical-load document waiver (contract 0.14.3, Q462): closed by default, opened only by a System Admin (the mock `pm`
// account), 30 days, a cutoff date that is not in the future. The batch handlers read it to accept or refuse "historical load: accept without documents".
import type { HistoricalWaiver } from '@/api/historicalWaiver';
import { db, viewer } from './db';

export interface WaiverState {
  open: boolean; cutoff_date: string | null; opened_at: string | null; expires_at: string | null; reason: string | null; opened_by: string | null;
  closed_at: string | null; closed_how: 'manual' | 'expired' | null;
}
const states = new WeakMap<object, WaiverState>();

export function waiver(): WaiverState {
  const key = db() as unknown as object;
  let s = states.get(key);
  if (!s) { s = { open: false, cutoff_date: null, opened_at: null, expires_at: null, reason: null, opened_by: null, closed_at: null, closed_how: null }; states.set(key, s); }
  if (s.open && s.expires_at && new Date(s.expires_at).getTime() <= Date.now()) Object.assign(s, { open: false, cutoff_date: null, closed_at: s.expires_at, closed_how: 'expired' });
  return s;
}
export const isSystemAdmin = () => viewer()?.key === 'pm';
export const waiverToday = () => new Date().toISOString().slice(0, 10);

/** The state as the API gives it: the reason and the opener only to a System Admin. */
export function waiverView(): HistoricalWaiver {
  const w = waiver(), adm = isSystemAdmin();
  return {
    open: w.open, cutoff_date: w.open ? w.cutoff_date : null, opened_at: w.open ? w.opened_at : null, expires_at: w.open ? w.expires_at : null,
    days_left: w.open && w.expires_at ? Math.max(0, Math.ceil((new Date(w.expires_at).getTime() - Date.now()) / 86_400_000)) : null, window_days: 30,
    opened_by: w.open && adm ? w.opened_by : null, reason: w.open && adm ? w.reason : null, closed_at: w.closed_at, closed_how: w.closed_how, can_manage: adm,
  };
}
