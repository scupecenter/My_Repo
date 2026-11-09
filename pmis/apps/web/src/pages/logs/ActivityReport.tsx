import { Download, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadActivityXlsx, useActivityReport, type ActivityReport as Report } from '@/api/logs';
import { stamp, Who } from '@/components/logs/bits';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { tripoliToday } from '@/lib/today';

export const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s; };
/** CSV built in the browser from what is on screen. A leading = + - @ is neutralised so a spreadsheet never runs it as a formula. */
export function reportCsv(r: Report): string {
  const head = ['employee_id', 'name', 'actions', 'field_changes', 'approvals', 'sign_ins', 'failed_sign_ins'];
  const rows = r.users.map((u) => [u.user.employee_id, u.user.display_name, u.actions, u.field_changes, u.approvals, u.sign_ins, u.failed_sign_ins]);
  const sens = r.sensitive.map((s) => [s.at, s.actor.display_name, s.action, s.entity_type, s.entity_label, s.summary]);
  return ['﻿' + [head, ...rows].map((l) => l.map(csvCell).join(',')).join('\n'), '', ['at', 'actor', 'action', 'entity_type', 'entity', 'summary'].join(','), ...sens.map((l) => l.map(csvCell).join(','))].join('\n');
}

export function ActivityReport() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(tripoliToday().slice(0, 7));
  const r = useActivityReport(month);
  const download = () => {
    if (!r.data) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([reportCsv(r.data)], { type: 'text/csv;charset=utf-8' }));
    a.download = `activity-${month}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const th = (k: string) => <th key={k} className="p-2 text-start">{t(`logs.r_${k}`)}</th>;
  return (
    <div data-testid="page-activity-report" className="space-y-3">
      <PageHeader title={t('nav.logs.activity_report')} subtitle={t('logs.report_subtitle')} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-semibold">{t('logs.r_month')}<input type="month" className="input mt-1 font-normal" data-testid="report-month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        <button className="btn btn-accent ms-auto" data-testid="report-xlsx" onClick={() => void downloadActivityXlsx(month).catch(() => undefined)}><FileSpreadsheet size={14} />{t('logs.r_xlsx')}</button>
        <button className="btn" data-testid="report-csv" disabled={!r.data} onClick={download}><Download size={14} />{t('logs.r_csv')}</button>
      </div>
      {r.isError ? <ErrorState onRetry={() => void r.refetch()} /> : r.isLoading ? <LoadingSkeleton /> : r.data && (
        <>
          <section aria-label={t('logs.r_per_user')} className="card overflow-x-auto">
            <table className="w-full text-sm"><thead className="border-b border-line bg-card2 text-mute"><tr>{['user', 'actions', 'field_changes', 'approvals', 'sign_ins', 'failed'].map(th)}</tr></thead>
              <tbody data-testid="report-users">
                {r.data.users.map((u) => (
                  <tr key={u.user.id} className="border-b border-line" data-testid={`report-user-${u.user.employee_id}`}>
                    <td className="p-2"><Who a={u.user} /></td><td className="p-2">{u.actions}</td><td className="p-2">{u.field_changes}</td><td className="p-2">{u.approvals}</td><td className="p-2">{u.sign_ins}</td>
                    <td className={`p-2 ${u.failed_sign_ins >= 5 ? 'font-bold text-lateInk' : ''}`}>{u.failed_sign_ins}</td>
                  </tr>))}
              </tbody></table>
            {!r.data.users.length && <EmptyState title={t('logs.empty')} testid="report-empty" />}
          </section>
          <section aria-labelledby="rs-sens" className="card p-3">
            <h2 id="rs-sens" className="mb-2 font-bold">{t('logs.r_sensitive')}</h2>
            <ul className="space-y-1 text-sm" data-testid="report-sensitive">
              {r.data.sensitive.map((s, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 border-b border-line py-1" data-testid={`report-sens-${i}`}>
                  <span className="mono text-xs" dir="ltr">{stamp(s.at)}</span><Who a={s.actor} /><span className="mono text-xs" dir="ltr">{s.action}</span><span>{s.entity_label}</span><span className="text-mute" dir="auto">{s.summary}</span>
                </li>))}
              {!r.data.sensitive.length && <li className="text-mute">{t('logs.r_none')}</li>}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
