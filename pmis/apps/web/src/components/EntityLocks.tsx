import { Lock, Unlock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEntityLocks, useSetEntityColumnLock, useSetEntityLock, type EntityColumnKind, type EntityLockKind } from '@/api/entityLocks';
import { FormDialog, errText } from './FormDialog';

/** Lock or unlock one target (an item, a movement, a plan or a row). Reason and step-up as the register locks; the database decides the right. */
export function EntityLockButton({ kind, id, testid }: { kind: EntityLockKind; id: string; testid: string }) {
  const { t } = useTranslation();
  const locks = useEntityLocks(kind);
  const set = useSetEntityLock(kind);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const locked = (locks.data?.records ?? []).some((l) => l.target_id === id);
  return (
    <>
      {locked && <span className="chip ms-2 bg-lockBg text-lockInk" data-testid={`${testid}-badge`}>{t('entity_locks.locked_badge')}</span>}
      <button className="btn" data-testid={testid} onClick={() => { setErr(null); setOpen(true); }}>{locked ? <Unlock size={14} /> : <Lock size={14} />}{' '}{t(locked ? 'entity_locks.unlock' : 'entity_locks.lock')}</button>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid={`${testid}-dialog`} busy={set.isPending} error={err} title={t(locked ? 'entity_locks.unlock_title' : 'entity_locks.lock_title')}
          onSubmit={(reason) => set.mutate({ id, locked: !locked, reason }, { onSuccess: () => setOpen(false), onError: (e) => setErr(errText(e, t)) })}>
          <p className="text-sm text-mute">{t(locked ? 'entity_locks.unlock_note' : 'entity_locks.lock_note')}</p>
        </FormDialog>
      )}
    </>
  );
}

/** The column locks of one kind: the open ones with Unlock, and a picker to lock one more. Every column listed is shared by all regions. */
export function EntityColumnLocks({ kind, options, testid }: { kind: EntityColumnKind; options: { code: string; label: string }[]; testid: string }) {
  const { t } = useTranslation();
  const locks = useEntityLocks(kind);
  const set = useSetEntityColumnLock(kind);
  const [pick, setPick] = useState('');
  const [dlg, setDlg] = useState<{ field: string; locked: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const open = (locks.data?.columns ?? []).filter((c) => c.kind === kind);
  const label = (code: string) => options.find((o) => o.code === code)?.label ?? code;
  return (
    <section className="my-3 rounded border border-line p-3" data-testid={testid} aria-label={t('entity_locks.columns_title')}>
      <h3 className="mb-2 text-sm font-semibold">{t('entity_locks.columns_title')}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input max-w-64" aria-label={t('entity_locks.column_select')} data-testid={`${testid}-select`} value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">{t('entity_locks.column_select')}</option>
          {options.filter((o) => !open.some((c) => c.field === o.code)).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
        <button className="btn" data-testid={`${testid}-lock`} disabled={!pick} onClick={() => { setErr(null); setDlg({ field: pick, locked: true }); }}><Lock size={14} /> {t('entity_locks.lock_column')}</button>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {open.map((c) => (
          <li key={c.id} data-testid={`${testid}-open-${c.field}`} className="flex items-center gap-2">
            <span className="chip bg-lockBg text-lockInk">{label(c.field)}</span><span className="text-mute">{c.reason}</span>
            <button className="btn ms-auto" onClick={() => { setErr(null); setDlg({ field: c.field, locked: false }); }}><Unlock size={14} /> {t('entity_locks.unlock')}</button>
          </li>
        ))}
        {!open.length && <li className="text-mute">{t('entity_locks.none')}</li>}
      </ul>
      {dlg && (
        <FormDialog open onClose={() => setDlg(null)} testid={`${testid}-dialog`} busy={set.isPending} error={err} title={t(dlg.locked ? 'entity_locks.lock_column' : 'entity_locks.unlock_column')}
          onSubmit={(reason) => set.mutate({ field: dlg.field, locked: dlg.locked, reason }, { onSuccess: () => { setDlg(null); setPick(''); }, onError: (e) => setErr(errText(e, t)) })}>
          <p className="text-sm">{label(dlg.field)}</p>
        </FormDialog>
      )}
    </section>
  );
}
