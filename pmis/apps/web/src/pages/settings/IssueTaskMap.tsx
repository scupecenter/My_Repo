import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useListCatalogues } from '@/api/lists';
import { useIssueTaskMap, useSaveIssueTaskMap } from '@/api/settings';
import type { IssueTaskMapItem } from '@/api/types';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { useErr } from './wf/useErr';

/**
 * Settings > Registers > Issue category by task (contract 0.15.87). Where a site is stopped decides the category and the reason of its derived issue row:
 * one line per task, seeded from the task group, every value editable here (values come from the lists Issue category and Blocker reason, which are
 * themselves editable in Settings > Registers > Lists). Saving needs a reason and is audited; nothing is deleted (a line is hidden, not removed).
 */
export function IssueTaskMap() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const err = useErr();
  const q = useIssueTaskMap();
  const lists = useListCatalogues(false);
  const save = useSaveIssueTaskMap();
  const [dlg, setDlg] = useState<null | IssueTaskMapItem>(null);
  const [cat, setCat] = useState('');
  const [rsn, setRsn] = useState('');
  const [active, setActive] = useState(true);
  const [why, setWhy] = useState('');
  const d = q.data;
  if (!d) return <section className="card p-4" data-testid="issue-map"><QueryFallback queries={[q]} testid="issue-map-loading" /></section>;
  const values = (code: string) => (lists.data ?? []).find((c) => c.code === code)?.values.filter((v) => v.is_active) ?? [];
  const label = (code: string, v: string | null | undefined) => {
    if (!v) return '';
    const x = (lists.data ?? []).find((c) => c.code === code)?.values.find((y) => y.code === v);
    return (i18n.language === 'ar' ? x?.label_ar : null) ?? x?.label_en ?? v;
  };
  const open = (r: IssueTaskMapItem) => { setCat(r.category ?? 'Other'); setRsn(r.blocker_reason ?? r.reason ?? ''); setActive(r.is_active ?? true); setWhy(''); setDlg(r); };
  const submit = () => {
    if (!dlg) return;
    save.mutate({ task: dlg.task_code, category: cat, reason: rsn || null, is_active: active, why: why.trim() }, {
      onSuccess: () => setDlg(null),
      onError: (e) => toast(err(e)),
    });
  };
  return (
    <section className="card space-y-3 p-4" data-testid="issue-map">
      <h2 className="font-bold">{t('issueMap.title')}</h2>
      <p className="text-sm text-mute">{t('issueMap.note')}</p>
      <p role="status" className={`chip ${d.counts.not_classified > 0 ? 'bg-waitBg text-waitInk' : 'bg-doneBg text-doneInk'}`} data-testid="issue-map-banner" data-unclassified={d.counts.not_classified}>
        {d.counts.not_classified > 0 ? t('issueMap.banner_unclassified', { n: d.counts.not_classified }) : t('issueMap.banner_ok')}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-mute"><tr>{['task', 'stage', 'category', 'reason', 'actions'].map((k) => <th key={k} className="p-2 text-start">{t(`issueMap.col_${k}`)}</th>)}</tr></thead>
          <tbody data-testid="issue-map-rows">
            {d.items.map((r) => (
              <tr key={r.task_code} className="border-t border-line" data-testid={`issue-map-${r.task_code}`} data-active={r.is_active}>
                <td className="p-2"><span className="font-mono">{r.task_code}</span> {r.name_en}</td>
                <td className="p-2">{r.stage_code}</td>
                <td className="p-2">{r.is_active ? label('IssueCategory', r.category) : t('issueMap.not_classified')}</td>
                <td className="p-2">{r.is_active ? label('BlockerReason', r.blocker_reason) || t('issueMap.not_classified') : ''}</td>
                <td className="p-2"><button className="btn" data-testid={`issue-map-edit-${r.task_code}`} onClick={() => open(r)}>{t('issueMap.edit')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dlg && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="issue-map-dialog">
          <div className="card w-full max-w-md space-y-3 p-4">
            <h3 className="font-bold">{t('issueMap.edit')}: {dlg.task_code}</h3>
            <label className="block text-sm">{t('issueMap.col_category')}
              <select className="input mt-1 w-full" data-testid="issue-map-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
                {values('IssueCategory').map((v) => <option key={v.code} value={v.code}>{label('IssueCategory', v.code)}</option>)}
              </select>
            </label>
            <label className="block text-sm">{t('issueMap.col_reason')}
              <select className="input mt-1 w-full" data-testid="issue-map-rsn" value={rsn} onChange={(e) => setRsn(e.target.value)}>
                <option value="">{t('issueMap.not_classified')}</option>
                {values('BlockerReason').map((v) => <option key={v.code} value={v.code}>{label('BlockerReason', v.code)}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{t('issueMap.active')}</label>
            <label className="block text-sm">{t('issueMap.why')}<input className="input mt-1 w-full" data-testid="issue-map-why" value={why} onChange={(e) => setWhy(e.target.value)} /></label>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setDlg(null)}>{t('issueMap.cancel')}</button>
              <button className="btn btn-accent" data-testid="issue-map-save" disabled={why.trim().length < 3 || !cat || save.isPending} onClick={submit}>{t('issueMap.save')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
