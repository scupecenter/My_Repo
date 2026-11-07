import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useExtendBooking, useFleetAvailability, useReadiness, useTopUp } from '@/api/fleet';
import type { RegisterRecord } from '@/api/types';
import { registerErrorMessage } from '@/lib/registerErrors';
import { PeoplePicker } from './PeoplePicker';
import { useToast } from './Toast';

export type Member = { user_id: string; member_role: 'supervisor' | 'executor'; is_lead?: boolean };

/** Procurement "Assignment": members list (user picker + role + lead). */
export function MembersEditor({ value, onChange, disabled, names }: { value: unknown; onChange: (v: Member[]) => void; disabled?: boolean; names?: Record<string, string> }) {
  const { t } = useTranslation();
  const rows = (Array.isArray(value) ? value : []) as Member[];
  const [known, setKnown] = useState<Record<string, string>>({});
  const nameOf = (id: string) => known[id] ?? names?.[id] ?? id;
  const patch = (i: number, p: Partial<Member>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : p.is_lead ? { ...r, is_lead: false } : r)));
  return (
    <div data-testid="reg-members" className="space-y-2">
      {rows.map((r, i) => (
        <div key={r.user_id} className="flex flex-wrap items-center gap-2" data-testid={`reg-member-${r.user_id}`}>
          <span className="chip bg-openBg text-openInk">{nameOf(r.user_id)}</span>
          <select className="input w-auto" aria-label={t('procAssign.role')} disabled={disabled} value={r.member_role} onChange={(e) => patch(i, { member_role: e.target.value as Member['member_role'] })}>
            <option value="supervisor">{t('procAssign.supervisor')}</option><option value="executor">{t('procAssign.executor')}</option>
          </select>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" disabled={disabled} checked={!!r.is_lead} onChange={(e) => patch(i, { is_lead: e.target.checked })} />{t('procAssign.lead')}</label>
          {!disabled && <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => onChange(rows.filter((_, j) => j !== i))}>{t('common.remove')}</button>}
        </div>
      ))}
      {!rows.length && <p className="text-sm text-mute">{t('procAssign.none')}</p>}
      {!disabled && <PeoplePicker id="reg-member-picker" single value={[]} onChange={([u]) => {
        if (!u || rows.some((r) => r.user_id === u.id)) return;
        setKnown((k) => ({ ...k, [u.id]: u.display_name }));
        onChange([...rows, { user_id: u.id, member_role: 'executor', is_lead: false }]);
      }} />}
    </div>
  );
}

const READY_TONE: Record<string, string> = { ready_to_mobilize: 'bg-doneBg text-doneInk', awaiting_vehicle: 'bg-waitBg text-waitInk', awaiting_advance: 'bg-waitBg text-waitInk', awaiting_both: 'bg-waitBg text-waitInk' };

/** Read-only readiness of a Procurement record (not_ready, or a null answer, is shown as not ready). */
export function ReadinessBadge({ recordId }: { recordId: string }) {
  const { t } = useTranslation();
  const q = useReadiness(recordId);
  if (!q.data) return null;
  const k = q.data.readiness ?? 'not_ready';
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="reg-readiness" data-readiness={k}>
      <span className="text-mute">{t('procAssign.readiness')}</span>
      <span className={`chip ${READY_TONE[k] ?? 'bg-lockBg text-lockInk'}`}>{t(`procAssign.ready.${k}`)}</span>
      {k === 'ready_to_mobilize' && q.data.ready_date && <span className="mono" data-testid="reg-ready-date">{q.data.ready_date}</span>}
    </p>
  );
}

/** Booking vehicle choice: only vehicles free in from..to; a 409 vehicle_already_reserved is shown by the drawer's save error. */
export function VehiclePicker({ value, onChange, from, to, vehicleType, homeRegion, bookingId, disabled, invalid }: {
  value: unknown; onChange: (v: string) => void; from?: string; to?: string; vehicleType?: string; homeRegion?: string; bookingId?: string; disabled?: boolean; invalid?: boolean;
}) {
  const { t } = useTranslation();
  const q = useFleetAvailability({ from, to, home_region: homeRegion || undefined, vehicle_type: vehicleType || undefined, exclude_booking_id: bookingId });
  const list = q.data ?? [];
  return (
    <div>
      <select id="reg-field-vehicle_id" data-testid="reg-field-vehicle_id" className="input" aria-invalid={invalid || undefined} disabled={disabled} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{from && to ? t('registers.choose') : t('fleet.pick_dates')}</option>
        {typeof value === 'string' && value && !list.some((v) => v.vehicle_id === value) && <option value={value}>{value}</option>}
        {list.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{[v.plate_no, v.vehicle_type, v.model, v.home_region].filter(Boolean).join(' · ')}</option>)}
      </select>
      {q.isSuccess && !list.length && <p className="text-sm text-mute" data-testid="reg-no-vehicles">{t('fleet.none_free')}</p>}
    </div>
  );
}

/** Clear sentence for the 409 of a double reservation. */
export const reservedMessage = (t: ReturnType<typeof useTranslation>['t'], e: unknown) =>
  e instanceof ApiError && e.status === 409 && e.code === 'vehicle_already_reserved' ? t('fleet.already_reserved') : null;

function ChildAction({ label, testid, children, onGo, busy, error }: { label: string; testid: string; children: React.ReactNode; onGo: () => void; busy: boolean; error: string | null }) {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md bg-card2 p-3" data-testid={`${testid}-box`}>
      {children}
      <button type="button" className="btn" data-testid={testid} disabled={busy} onClick={onGo}>{label}</button>
      {error && <p role="alert" data-testid={`${testid}-error`} className="w-full text-sm text-lateInk">{error}</p>}
    </div>
  );
}

export function ExtendBooking({ record, onDone }: { record: RegisterRecord; onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const m = useExtendBooking(record.id);
  const [to, setTo] = useState('');
  return (
    <ChildAction label={t('fleet.extend')} testid="reg-extend" busy={m.isPending || !to} error={m.isError ? reservedMessage(t, m.error) ?? registerErrorMessage(t, m.error) : null}
      onGo={() => m.mutate({ to_date: to }, { onSuccess: (r) => { toast(t('fleet.extended')); onDone(r.id); } })}>
      <label className="text-sm text-mute">{t('fleet.extend_to')}<input type="date" className="input mono" data-testid="reg-extend-to" value={to} onChange={(e) => setTo(e.target.value)} /></label>
    </ChildAction>
  );
}

export function TopUp({ record, onDone }: { record: RegisterRecord; onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const m = useTopUp(record.id);
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  return (
    <ChildAction label={t('fleet.top_up')} testid="reg-topup" busy={m.isPending || (!amount && !to)} error={m.isError ? registerErrorMessage(t, m.error) : null}
      onGo={() => m.mutate({ ...(amount ? { requested_amount: Number(amount) } : {}), ...(to ? { period_to: to } : {}) }, { onSuccess: (r) => { toast(t('fleet.topped_up')); onDone(r.id); } })}>
      <label className="text-sm text-mute">{t('fleet.top_up_amount')}<input type="number" min={0} className="input mono" data-testid="reg-topup-amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="text-sm text-mute">{t('fleet.period_to')}<input type="date" className="input mono" data-testid="reg-topup-to" value={to} onChange={(e) => setTo(e.target.value)} /></label>
    </ChildAction>
  );
}

/** Derived balance: "hidden" (never 0) when the server withheld the amounts (Q512). */
export function Balance({ record }: { record: RegisterRecord }) {
  const { t } = useTranslation();
  const d = record.data as { balance?: number | null; amounts_hidden?: boolean };
  const hidden = d.amounts_hidden === true || d.balance == null;
  return (
    <p className="text-sm" data-testid="reg-balance"><span className="text-mute">{t('fleet.balance')} </span>
      <span className="mono font-semibold" data-hidden={hidden || undefined}>{hidden ? t('fleet.hidden') : `${d.balance} LYD`}</span></p>
  );
}
