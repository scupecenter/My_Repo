import { Check, Clock, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useApprovals, useBulk, useDecide } from '@/api/hooks';
import type { ApprovalItem } from '@/api/types';
import { Holders } from '@/components/HolderChip';
import { PersonTag } from '@/components/PersonTag';
import { RejectDialog } from '@/components/RejectDialog';
import { useToast } from '@/components/Toast';

const TABS = ['all', 'review', 'approve'] as const;

export function Approvals() {
  const { t } = useTranslation();
  const toast = useToast();
  const [tab, setTab] = useState<(typeof TABS)[number]>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<ApprovalItem | null>(null);
  const list = useApprovals(tab, q);
  const decide = useDecide();
  const bulk = useBulk();
  const items = list.data?.items ?? [];
  const current = items.find((i) => i.task.id === sel) ?? null;

  const onError = (e: unknown) => toast(e instanceof ApiError && e.code === 'precondition_failed' ? t('errors.precondition_failed') : e instanceof ApiError && e.status === 403 ? t('errors.forbidden') : e instanceof ApiError && e.code === 'step_up_required' ? '' : t('errors.generic'), 'err');

  const act = (item: ApprovalItem, op: 'review' | 'approve') =>
    decide.mutate({ item, op }, { onSuccess: () => toast(t('approvals.done')), onError });

  const picked = items.filter((i) => checked.has(i.task.id));
  const kindOfPicked = picked.length && picked.every((i) => i.level_kind === picked[0].level_kind) ? picked[0].level_kind : null;
  const runBulk = (action: 'pass' | 'approve') =>
    bulk.mutate({ action, items: picked }, {
      onSuccess: (r) => { setChecked(new Set()); toast(t('approvals.bulk_result', { done: r.done.length, skipped: r.skipped.length, failed: r.failed.length }), r.failed.length ? 'err' : 'ok'); },
      onError,
    });

  const allChecked = items.length > 0 && picked.length === items.length;

  return (
    <div data-testid="page-approvals">
      <h1 className="text-2xl font-bold">{t('approvals.title')}</h1>
      <p className="mb-4 text-mute">{t('approvals.subtitle')}</p>
      <div className="grid gap-4 lg:grid-cols-[minmax(320px,5fr)_7fr]">
        <section className="card overflow-hidden">
          <div role="tablist" className="flex border-b border-line">
            {TABS.map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} data-testid={`approvals-tab-${k}`} onClick={() => setTab(k)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold ${tab === k ? 'border-b-2 border-accent text-accentText' : 'text-mute'}`}>
                {t(`approvals.tab_${k}`)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 border-b border-line p-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="approval-select-all" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(items.map((i) => i.task.id)))} />{t('approvals.select_all')}</label>
            <input className="input" data-testid="approvals-filter" placeholder={t('approvals.filter')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {picked.length > 0 && (
            <div className="flex items-center gap-2 border-b border-line bg-accentSoft p-3" data-testid="bulk-bar">
              <span className="flex-1 text-sm font-semibold">{t('approvals.selected', { count: picked.length })}</span>
              {kindOfPicked === 'review' && <button className="btn" data-testid="bulk-pass" onClick={() => runBulk('pass')}>{t('approvals.bulk_pass', { count: picked.length })}</button>}
              {kindOfPicked === 'approve' && <button className="btn btn-primary" data-testid="bulk-approve" onClick={() => runBulk('approve')}>{t('approvals.bulk_approve', { count: picked.length })}</button>}
            </div>
          )}
          <ul data-testid="approvals-list">
            {items.map((i) => (
              <li key={i.task.id} data-testid={`approval-row-${i.task.id}`} data-site={i.task.site_code} aria-selected={sel === i.task.id}
                className={`flex items-center gap-3 border-b border-line p-3 ${sel === i.task.id ? 'bg-openBg' : 'hover:bg-hover'}`}>
                <input type="checkbox" aria-label={i.task.site_code} data-testid={`approval-check-${i.task.id}`} checked={checked.has(i.task.id)}
                  onChange={() => setChecked((c) => { const n = new Set(c); if (n.has(i.task.id)) n.delete(i.task.id); else n.add(i.task.id); return n; })} />
                <button className="flex-1 text-start" data-testid={`approval-open-${i.task.id}`} onClick={() => setSel(i.task.id)}>
                  <div><b className="mono">{i.task.site_code}</b> {i.task.task_code} {i.task.name_en}</div>
                  <div className="text-sm text-mute">{t('approvals.entered_by')} {i.submitted_by?.display_name}</div>
                </button>
                <span className={`chip ${i.level_kind === 'approve' ? 'bg-waitBg text-waitInk' : 'bg-openBg text-openInk'}`}>{t(`approvals.level_${i.level_kind}`)}</span>
              </li>
            ))}
            {list.isSuccess && !items.length && <li className="p-6 text-center text-mute" data-testid="approvals-empty">{t('approvals.empty')}</li>}
          </ul>
        </section>
        <section className="card self-start" data-testid="approval-detail">
          {current ? <Detail item={current} onAct={act} onReject={() => setRejecting(current)} busy={decide.isPending} /> : <p className="p-6 text-mute">{t('approvals.select_one')}</p>}
        </section>
      </div>
      <RejectDialog key={rejecting?.task.id} open={!!rejecting} title={t('approvals.reject_title', { site: rejecting?.task.site_code })} onClose={() => setRejecting(null)} onSend={(note) => rejecting && decide.mutate({ item: rejecting, op: 'reject', note }, { onSuccess: () => { setRejecting(null); toast(t('approvals.done')); }, onError })} />
    </div>
  );
}

function Detail({ item, onAct, onReject, busy }: { item: ApprovalItem; onAct: (i: ApprovalItem, op: 'review' | 'approve') => void; onReject: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const tk = item.task;
  const op = item.level_kind === 'approve' ? 'approve' : 'review';
  return (
    <div>
      <div className="flex items-center justify-between border-b border-line p-4">
        <b><span className="mono">{tk.site_code}</span> · {tk.task_code} {tk.name_en}</b>
        <span className="chip bg-waitBg text-waitInk"><Clock size={12} className="me-1" />{item.level_kind === 'approve' ? t('approvals.awaiting') : t('approvals.in_review')}</span>
      </div>
      <dl className="grid grid-cols-2 gap-4 p-4 text-sm">
        <div><dt className="text-mute">{t('approvals.entered_by')}</dt><dd className="font-semibold">{item.submitted_by && <PersonTag name={item.submitted_by.display_name} employeeId={item.submitted_by.employee_id} />}</dd></div>
        <div><dt className="text-mute">{t('approvals.actual_date')}</dt><dd className="mono font-semibold">{tk.actual_date} <span className="font-normal text-mute">({t('approvals.plan')} {tk.planned_date})</span></dd></div>
        <div><dt className="text-mute">{t('grid.ball')}</dt><dd data-testid="approval-holders"><Holders holders={tk.ball_in_court?.holders ?? []} /></dd></div>
        <div><dt className="text-mute">{t('approvals.sla')}</dt><dd className="font-semibold">{tk.sla?.min_wd}–{tk.sla?.max_wd} {t('approvals.wd')}</dd></div>
      </dl>
      <div className="px-4 pb-2 text-sm">
        <div className="font-semibold">{t('approvals.documents', { count: item.documents_summary?.length ?? tk.slots_filled ?? 0 })}</div>
        <ul data-testid="approval-docs">{item.documents_summary?.map((s) => <li key={s.slot_id} className="mono py-1">{s.name} <span className="chip bg-waitBg text-waitInk">{s.status}</span> <span className="text-mute">×{s.file_count}</span></li>)}</ul>
      </div>
      <div className="flex gap-2 p-4">
        <button className="btn btn-danger ms-auto" data-testid="approval-reject" onClick={onReject} disabled={busy}><Undo2 size={16} />{t('approvals.reject')}</button>
        <button className="btn btn-primary" data-testid={op === 'approve' ? 'approval-approve' : 'approval-pass'} onClick={() => onAct(item, op)} disabled={busy}><Check size={16} />{t(op === 'approve' ? 'approvals.approve' : 'approvals.pass')}</button>
      </div>
    </div>
  );
}
