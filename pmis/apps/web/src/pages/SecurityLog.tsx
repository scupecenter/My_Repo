import { Download, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { exportSecurityLog, useSecurityLog, useVerifyIntegrity, type SecFilter } from '@/api/settings';
import type { LogIntegrity, SecurityEvent } from '@/api/types';
import { errText } from '@/components/FormDialog';
import { PersonTag } from '@/components/PersonTag';
import { useToast } from '@/components/Toast';
import { hasGrant, isAdmin } from '@/lib/perm';

export const EVENTS: SecurityEvent[] = ['sign_in_started', 'sign_in_succeeded', 'callback_account_mismatch', 'sign_in_failed', 'signed_out', 'session_expired', 'session_revoked_by_admin', 'mfa_exemption_granted', 'mfa_exemption_revoked', 'step_up_passed', 'step_up_failed', 'break_glass_used'];
const TONE = { success: 'bg-doneBg text-doneInk', failure: 'bg-lateBg text-lateInk', info: 'bg-openBg text-openInk' } as const;

function IntegrityCard({ r }: { r: LogIntegrity }) {
  const { t } = useTranslation();
  return (
    <div className="card space-y-1 p-3 text-sm" data-testid={`integrity-result-${r.log}`}>
      <div className="flex items-center gap-2 font-bold">{t(`seclog.log_${r.log}`)}<span className={`chip ${r.status === 'ok' ? 'bg-doneBg text-doneInk' : 'bg-lateBg text-lateInk'}`} data-testid={`integrity-status-${r.log}`}>{t(`seclog.integrity_${r.status}`)}</span></div>
      <div>{t('seclog.rows')}: <b data-testid={`integrity-count-${r.log}`}>{r.row_count}</b></div>
      <div>{t('seclog.seq_range')}: <span className="mono" data-testid={`integrity-range-${r.log}`}>{r.first_seq ?? '—'} → {r.last_seq ?? '—'}</span></div>
      <div>{t('seclog.head')}: <span className="mono break-all text-xs" dir="ltr" data-testid={`integrity-head-${r.log}`}>{r.head_hash ?? '—'}</span></div>
      <div>{t('seclog.breaks')}: <b data-testid={`integrity-breaks-${r.log}`}>{r.breaks.length}</b></div>
      {r.breaks.length > 0 && <ul className="list-disc ps-5 text-lateInk" data-testid={`integrity-break-list-${r.log}`}>{r.breaks.map((b) => <li key={b.seq}>#{b.seq} · {t(`seclog.break_${b.kind}`)}</li>)}</ul>}
    </div>
  );
}

export function SecurityLog() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const me = useMe(true);
  const [f, setF] = useState<SecFilter>({ from: '', to: '', event: [], outcome: '', q: '' });
  const q = useSecurityLog(f), verify = useVerifyIntegrity();
  const [res, setRes] = useState<Partial<Record<'audit' | 'security', LogIntegrity>>>({});
  const [exporting, setExporting] = useState(false);
  const admin = isAdmin(me.data), canExport = admin || hasGrant(me.data, 'export');
  const items = q.data ?? [];
  const ar = i18n.language === 'ar';
  const run = (log: 'audit' | 'security') => verify.mutate(log, { onSuccess: (r) => setRes((x) => ({ ...x, [log]: r })), onError: (e) => toast(errText(e, t), 'err') });
  const doExport = () => { setExporting(true); exportSecurityLog(f).then(() => toast(t('seclog.exported'))).catch((e) => toast(errText(e, t), 'err')).finally(() => setExporting(false)); };
  return (
    <div data-testid="page-security-log" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="me-auto"><h1 className="text-2xl font-bold">{t('nav.admin.security_log')}</h1><p className="text-mute">{t('seclog.subtitle')}</p></div>
        {admin && (['audit', 'security'] as const).map((l) => <button key={l} className="btn" data-testid={`integrity-${l}`} disabled={verify.isPending} onClick={() => run(l)}><ShieldCheck size={14} />{t('seclog.verify', { log: t(`seclog.log_${l}`) })}</button>)}
        {canExport && <button className="btn" data-testid="seclog-export" disabled={exporting} onClick={doExport}><Download size={14} />{t('seclog.export')}</button>}
      </div>
      {(res.audit || res.security) && <div className="grid gap-3 md:grid-cols-2" data-testid="integrity-results">{res.audit && <IntegrityCard r={res.audit} />}{res.security && <IntegrityCard r={res.security} />}</div>}
      <div className="card flex flex-wrap items-end gap-3 p-3" data-testid="seclog-filters">
        <label className="text-sm font-semibold">{t('seclog.from')}<input type="date" className="input mt-1 font-normal" data-testid="seclog-from" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="text-sm font-semibold">{t('seclog.to')}<input type="date" className="input mt-1 font-normal" data-testid="seclog-to" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="text-sm font-semibold">{t('seclog.outcome')}
          <select className="input mt-1 font-normal" data-testid="seclog-outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}><option value="">{t('common.all')}</option>{['success', 'failure', 'info'].map((o) => <option key={o} value={o}>{t(`seclog.outcome_${o}`)}</option>)}</select></label>
        <label className="text-sm font-semibold">{t('seclog.event')}
          <select multiple size={3} className="input mt-1 font-normal" data-testid="seclog-event" value={f.event} onChange={(e) => setF({ ...f, event: [...e.target.selectedOptions].map((o) => o.value) })}>{EVENTS.map((x) => <option key={x} value={x}>{t(`seclog.ev_${x}`)}</option>)}</select></label>
        <label className="min-w-48 flex-1 text-sm font-semibold">{t('seclog.search')}<input className="input mt-1 font-normal" data-testid="seclog-q" placeholder={t('seclog.search_hint')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-mute"><tr>
            <th className="p-2 text-start">#</th><th className="p-2 text-start">{t('seclog.at')}</th><th className="p-2 text-start">{t('seclog.event')}</th><th className="p-2 text-start">{t('seclog.outcome')}</th><th className="p-2 text-start">{t('seclog.who')}</th><th className="p-2 text-start">{t('seclog.actor')}</th>
            {admin && <th className="p-2 text-start" data-testid="seclog-ip-col">IP</th>}<th className="p-2 text-start">{t('seclog.request')}</th>
          </tr></thead>
          <tbody data-testid="seclog-list">
            {items.map((e) => (
              <tr key={e.id} className="border-b border-line" data-testid={`seclog-row-${e.id}`}>
                <td className="mono p-2 text-xs">{e.id}</td><td className="mono p-2 text-xs" dir="ltr">{new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)}</td>
                <td className="p-2">{t(`seclog.ev_${e.event}`)}</td><td className="p-2"><span className={`chip ${TONE[e.outcome]}`}>{t(`seclog.outcome_${e.outcome}`)}</span></td>
                <td className="p-2">{e.user ? <PersonTag name={e.user.display_name} employeeId={e.user.employee_id} /> : <span className="mono" dir="ltr" data-testid={`seclog-masked-${e.id}`}>{e.identifier_masked}</span>}</td>
                <td className="p-2">{e.actor && <PersonTag name={e.actor.display_name} employeeId={e.actor.employee_id} />}</td>
                {admin && <td className="mono p-2 text-xs" dir="ltr" data-testid={`seclog-ip-${e.id}`}>{e.ip ?? '—'}</td>}
                <td className="mono p-2 text-xs" dir="ltr">{e.request_id}</td>
              </tr>))}
            {q.isSuccess && !items.length && <tr><td colSpan={8} className="p-6 text-center text-mute" data-testid="seclog-empty">{t('seclog.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-mute" data-dir={ar ? 'rtl' : 'ltr'}>{t('seclog.audited_read')}</p>
    </div>
  );
}
