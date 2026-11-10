import { Lock, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useImportSites, useSetWorkflowLocks, type LocksTarget } from '@/api/sites';
import type { SiteDataGap } from '@/api/types';
import { errText, FormDialog } from './FormDialog';
import { useToast } from './Toast';

/**
 * Contract 0.15.4 (migration 0085): the per-site workflow locks. Locked (the default) = a task waits for its predecessors and for the gate in front of its
 * stage; Open = dates in any order (L1/L2, documents and validation still apply; an approval that bypasses a lock is flagged "Admin override").
 * Switching needs a System Admin or the delegated right to unlock for the region, a reason and a step-up (the server decides; the button shows for `can_manage`).
 */
export function LocksDialog({ target, locked, onClose, testid = 'locks-dialog', count }: { target: LocksTarget; locked: boolean; onClose: () => void; testid?: string; count?: number }) {
  const { t } = useTranslation();
  const toast = useToast();
  const m = useSetWorkflowLocks();
  return (
    <FormDialog open onClose={onClose} testid={testid} title={t(locked ? 'locks.lock_title' : 'locks.open_title', { count: count ?? 1 })} busy={m.isPending}
      error={m.isError ? errText(m.error, t) : null} submitLabel={t(locked ? 'locks.lock' : 'locks.open')}
      onSubmit={(reason) => m.mutate({ target, locked, reason }, { onSuccess: (r) => { toast(t('locks.done', { count: r.changed })); onClose(); } })}>
      <p className="text-sm text-mute" data-testid={`${testid}-note`}>{t(locked ? 'locks.lock_note' : 'locks.open_note')}</p>
    </FormDialog>
  );
}

/** The chip of the site page header ("Locks: on / off") and, for an authorized user, the toggle. */
export function LocksChip({ siteId, locked, canManage }: { siteId: string; locked: boolean; canManage: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`chip ${locked ? 'bg-lockBg text-lockInk' : 'bg-waitBg text-waitInk'}`} data-testid="site-locks-chip" data-locked={locked} title={t(locked ? 'locks.on_title' : 'locks.off_title')}>
        {locked ? <Lock size={12} className="me-1" aria-hidden /> : <LockOpen size={12} className="me-1" aria-hidden />}{t(locked ? 'locks.on' : 'locks.off')}
      </span>
      {canManage && <button type="button" className="btn px-2 py-0.5 text-xs" data-testid="site-locks-toggle" onClick={() => setOpen(true)}>{t(locked ? 'locks.open' : 'locks.lock')}</button>}
      {open && <LocksDialog target={{ site_id: siteId }} locked={!locked} onClose={() => setOpen(false)} testid="site-locks-dialog" />}
    </span>
  );
}

/** "Data gaps": the missing required values of a site (the title lists them). */
export function DataGapsChip({ count, items, testid = 'site-data-gaps' }: { count: number; items?: SiteDataGap[]; testid?: string }) {
  const { t } = useTranslation();
  if (!count) return null;
  const lines = (items ?? []).map((g) => (g.kind === 'missing_actual_date' ? t('locks.gap_task', { task: g.task_code, next: g.successor_code }) : t('locks.gap_field', { field: t(`locks.field_${g.field ?? 'other'}`, { defaultValue: g.field ?? '' }) })));
  return <span className="chip bg-lateBg text-lateInk" data-testid={testid} title={lines.join('\n') || undefined}>{t('locks.gaps', { count })}</span>;
}

/** The status of every site of a Master import run or of a batch, with its missing data (warnings and data gaps), a filter, and "lock them again". */
export function ImportSitesPanel({ source, id, canManage }: { source: 'run' | 'batch'; id: string; canManage?: boolean }) {
  const { t } = useTranslation();
  const [only, setOnly] = useState(false);
  const [lock, setLock] = useState(false);
  const q = useImportSites(source, id, only);
  const items = q.data?.items ?? [];
  const anyOpen = items.some((s) => !s.workflow_locks);
  return (
    <section className="card mt-4 p-3" data-testid="import-sites">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="me-auto font-semibold">{t('locks.sites_title')}</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="import-sites-gaps-only" checked={only} onChange={(e) => setOnly(e.target.checked)} />{t('locks.gaps_only')}</label>
        {canManage && anyOpen && <button type="button" className="btn px-2 py-1 text-xs" data-testid="import-sites-lock-all" onClick={() => setLock(true)}><Lock size={14} />{t('locks.lock_all')}</button>}
      </div>
      {q.isLoading ? <p className="text-mute">{t('common.loading')}</p> : !items.length ? <p className="text-mute" data-testid="import-sites-empty">{t('locks.sites_empty')}</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-start text-mute">
            <th className="px-2 text-start">{t('sites.code')}</th><th className="px-2 text-start">{t('sites.status')}</th><th className="px-2 text-start">{t('locks.stream')}</th>
            <th className="px-2 text-start">{t('locks.milestone')}</th><th className="px-2 text-start">{t('locks.done')}</th><th className="px-2 text-start">{t('locks.column')}</th>
            <th className="px-2 text-start">{t('locks.missing')}</th>
          </tr></thead>
          <tbody>{items.map((s) => (
            <tr key={s.site_id} className="border-t border-line" data-testid={`import-site-${s.site_code}`}>
              <td className="px-2"><Link className="mono text-link" to={`/sites/${s.site_id}`}>{s.site_code}</Link></td>
              <td className="px-2">{t(`status.${s.overall_status}`)}</td>
              <td className="px-2">{s.current_stream ?? '—'}</td>
              <td className="px-2">{s.next_milestone ? t(`stage.${s.next_milestone}`, { defaultValue: s.next_milestone }) : '—'}</td>
              <td className="mono px-2">{s.done_tasks}/{s.total_tasks}</td>
              <td className="px-2" data-testid={`import-site-locks-${s.site_code}`}>{t(s.workflow_locks ? 'locks.on' : 'locks.off')}</td>
              <td className="px-2" data-testid={`import-site-missing-${s.site_code}`}>{s.warnings + s.data_gaps > 0 ? <span className="chip bg-lateBg text-lateInk">{t('locks.missing_n', { warnings: s.warnings, gaps: s.data_gaps })}</span> : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {lock && <LocksDialog target={source === 'run' ? { master_run_id: id } : { import_batch_id: id }} locked onClose={() => setLock(false)} testid="import-sites-lock-dialog" count={items.length} />}
    </section>
  );
}
