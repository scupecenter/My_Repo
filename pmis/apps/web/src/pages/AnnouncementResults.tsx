import { Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { exportAnnouncement, useAnnouncement, useAnnouncementResponses } from '@/api/msg';
import { errText } from '@/components/FormDialog';
import { PersonTag } from '@/components/PersonTag';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

const TONE: Record<string, string> = { agree: 'bg-doneBg text-doneInk', disagree: 'bg-lateBg text-lateInk', pending: 'bg-waitBg text-waitInk' };

export function AnnouncementResults() {
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const toast = useToast();
  const [decision, setDecision] = useState('');
  const [busy, setBusy] = useState(false);
  const a = useAnnouncement(id);
  const rows = useAnnouncementResponses(id, decision);
  const ar = i18n.language === 'ar';
  if (a.isError) return <p role="alert" data-testid="ann-missing" className="text-lateInk">{t('ann.missing')}</p>;
  const d = a.data;
  if (!d) return <p>{t('common.loading')}</p>;
  const items = rows.data?.pages.flatMap((p) => p.items) ?? [];
  const aud = d.audience;
  const chips: { key: string; label: string }[] = [
    ...(aud.all ? [{ key: 'all', label: t('annNew.everyone') }] : []),
    ...(aud.users ?? []).map((u) => ({ key: `u${u.id}`, label: `${u.display_name}${u.employee_id ? ` (${u.employee_id})` : ''}` })),
    ...(aud.groups ?? []).map((g) => ({ key: `g${g.id}`, label: `${t('annNew.groups')}: ${g.name}` })),
    ...(aud.roles ?? []).map((r) => ({ key: `r${r.id}`, label: `${t('annNew.roles')}: ${(ar && r.name_ar) || r.name_en}` })),
    ...(aud.departments ?? []).map((x) => ({ key: `d${x.id}`, label: `${t('annNew.departments')}: ${(ar && x.name_ar) || x.name_en}` })),
  ];
  const stat = (k: 'recipients' | 'agree' | 'disagree' | 'pending', n: number) => (
    <div className="card p-3 text-center" data-testid={`ann-stat-${k}`}><div className="text-2xl font-bold">{n}</div><div className="text-sm text-mute">{t(`ann.${k}`)}</div></div>
  );
  return (
    <div data-testid="page-announcement" className="space-y-4">
      <Link to="/admin/announcements" className="text-sm text-mute">{t('ann.back')}</Link>
      <div>
        <h1 className="text-2xl font-bold" dir="auto" data-testid="ann-detail-title">{d.title}</h1>
        <p className="text-sm text-mute"><bdi>{t('annPopup.from', { name: d.created_by.display_name })}</bdi> · <bdi>{fmtDateTime(d.created_at, i18n.language)}</bdi></p>
      </div>
      <div className="card whitespace-pre-wrap break-words p-4" dir="auto" data-testid="ann-detail-body">{d.body}</div>
      <section><h2 className="mb-1 text-sm font-semibold text-mute">{t('ann.audience')}</h2>
        <div className="flex flex-wrap gap-1" data-testid="ann-audience">{chips.map((c) => <span key={c.key} className="chip bg-openBg text-openInk">{c.label}</span>)}</div></section>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stat('recipients', d.recipient_count)}{stat('agree', d.agree_count)}{stat('disagree', d.disagree_count)}{stat('pending', d.pending_count)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm font-semibold">{t('ann.decision')}
          <select className="input w-auto font-normal" data-testid="ann-filter" value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="">{t('ann.all')}</option>
            {(['agree', 'disagree', 'pending'] as const).map((k) => <option key={k} value={k}>{t(`ann.dec_${k}`)}</option>)}
          </select></label>
        <span className="flex-1" />
        <button className="btn" data-testid="ann-export" disabled={busy} onClick={() => { setBusy(true); exportAnnouncement(id).then((n) => toast(t('ann.exported', { name: n })), (e) => toast(errText(e, t), 'err')).finally(() => setBusy(false)); }}><Download size={16} />{t('ann.export')}</button>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-mute"><tr>
            <th className="p-2 text-start">{t('ann.col_person')}</th><th className="p-2 text-start">{t('ann.col_department')}</th><th className="p-2 text-start">{t('ann.decision')}</th><th className="p-2 text-start">{t('ann.note')}</th><th className="p-2 text-start">{t('ann.answered_at')}</th>
          </tr></thead>
          <tbody data-testid="ann-responses">
            {items.map((r) => (
              <tr key={r.user.id} className="border-b border-line" data-testid={`ann-resp-${r.user.employee_id ?? r.user.id}`}>
                <td className="p-2"><PersonTag name={r.user.display_name} employeeId={r.user.employee_id} /></td>
                <td className="p-2 text-mute">{r.department ? (ar && r.department.name_ar) || r.department.name_en : '—'}</td>
                <td className="p-2"><span className={`chip ${TONE[r.decision]}`} data-testid={`ann-resp-decision-${r.user.employee_id ?? r.user.id}`}>{t(`ann.dec_${r.decision}`)}</span></td>
                <td className="p-2" dir="auto"><span className="whitespace-pre-wrap break-words" data-testid={`ann-resp-note-${r.user.employee_id ?? r.user.id}`}>{r.note ?? ''}</span></td>
                <td className="p-2 text-mute">{fmtDateTime(r.responded_at, i18n.language)}</td>
              </tr>
            ))}
            {rows.isSuccess && !items.length && <tr><td colSpan={5} className="p-6 text-center text-mute" data-testid="ann-resp-empty">{t('ann.no_rows')}</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.hasNextPage && <button className="btn" data-testid="ann-more" disabled={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>{t('ann.more')}</button>}
    </div>
  );
}
