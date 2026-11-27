import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { saveSiteMasterCell, type SiteMasterMenuItem } from '@/api/siteMaster';
import { errText } from '@/components/FormDialog';
import { anyMissingParent, columnKind, columnOptions, editableOrds, planBulk, runBulk, SKIP_REASONS, toValue, type BulkOutcome, type BulkPlan, type BulkRow } from '@/lib/siteBulkEdit';
import { DateInput } from '@/components/DateInput';

type Phase = 'form' | 'running' | 'done';

/**
 * Bulk edit of one column for the selected sites (owner request 2026-11-22). Pick a field of the current menu, enter one value with the typed editor, see how
 * many sites will change and how many are skipped, confirm; each eligible cell is then saved by the same call as a single inline edit (PATCH /tasks/{id} with
 * If-Match), a few at a time, and a summary lists saved, skipped and failed sites with the reasons. No new right: the server decides every cell.
 */
export function SitesBulkEdit({ menu, rows, onClose, onRefresh }: { menu: SiteMasterMenuItem; rows: BulkRow[]; onClose: (failed?: string[]) => void; onRefresh: () => Promise<unknown> }) {
  const { t, i18n } = useTranslation();
  const [ord, setOrd] = useState(0);
  const [draft, setDraft] = useState('');
  const [clear, setClear] = useState(false); // clear the value (send null) instead of entering one
  const [phase, setPhase] = useState<Phase>('form');
  const [done, setDone] = useState(0);
  const [outcomes, setOutcomes] = useState<BulkOutcome[]>([]);
  const [snap, setSnap] = useState<BulkPlan | null>(null); // the plan as confirmed: the rows are read again after the save, so the summary is not recomputed
  const cols = useMemo(() => menu.columns.filter((c) => c.ord !== 1 && c.ord !== 2).sort((a, b) => a.ord - b.ord), [menu]);
  const fields = useMemo(() => { const ok = new Set(editableOrds(rows, cols.map((c) => c.ord))); return cols.filter((c) => ok.has(c.ord)); }, [rows, cols]);
  const kind = ord ? columnKind(rows, ord) : null;
  const options = ord && kind === 'list' ? columnOptions(rows, ord) : [];
  const value = kind ? toValue(kind, draft) : null;
  const plan = kind && clear ? planBulk(rows, ord, kind, null) : kind && value !== null ? planBulk(rows, ord, kind, value) : null;
  const shown = phase === 'form' ? plan : snap;
  const skipCount = (r: string) => shown?.skipped.filter((s) => s.reason === r).length ?? 0;
  const label = (o: { label_en: string; label_ar: string | null }) => (i18n.language === 'ar' && o.label_ar) || o.label_en;

  const confirm = async () => {
    if (!plan || (!clear && value === null) || !plan.change.length) return;
    setSnap(plan); setPhase('running'); setDone(0);
    const res = await runBulk(plan.change, clear ? null : value, saveSiteMasterCell, { onProgress: setDone });
    await onRefresh();
    setOutcomes(res); setPhase('done');
  };
  const failed = outcomes.filter((o): o is Extract<BulkOutcome, { status: 'failed' }> => o.status === 'failed');
  const reasonOf = (o: Extract<BulkOutcome, { status: 'failed' }>) => (o.http === 403 ? t('sites.wide_bulk_no_right') : errText(o.error, t as (k: string) => string));
  const savedCount = outcomes.length - failed.length;
  const header = (o: number) => cols.find((c) => c.ord === o)?.header ?? '';
  const skipList = (
    <ul className="list-disc ps-5 text-xs text-mute">
      {SKIP_REASONS.filter((r) => skipCount(r) > 0).map((r) => <li key={r} data-testid={`bulk-edit-skip-${r}`}>{t(`sites.wide_bulk_skip_${r}`, { count: skipCount(r) })}</li>)}
    </ul>
  );

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o && phase !== 'running') onClose(phase === 'done' ? failed.map((f) => f.code) : undefined); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="bulk-edit" className="card fixed inset-x-0 top-[6vh] z-[70] mx-auto max-h-[88vh] w-[min(560px,94vw)] space-y-3 overflow-y-auto p-5">
          <Dialog.Title className="text-lg font-bold">{t('sites.wide_bulk_title', { count: rows.length })}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute">{t('sites.wide_bulk_rights')}</Dialog.Description>
          {phase === 'form' && (
            <>
              {!fields.length ? <p data-testid="bulk-edit-none" className="text-sm">{t('sites.wide_bulk_no_fields')}</p> : (
                <>
                  <label className="block text-sm font-semibold" htmlFor="bulk-edit-field">{t('sites.wide_bulk_field')}</label>
                  <select id="bulk-edit-field" data-testid="bulk-edit-field" className="input w-full" value={ord} onChange={(e) => { setOrd(Number(e.target.value)); setDraft(''); setClear(false); }}>
                    <option value={0}>{t('sites.wide_bulk_choose')}</option>
                    {fields.map((c) => <option key={c.ord} value={c.ord}>{c.header}</option>)}
                  </select>
                  {kind && (
                    <div>
                      <label className="flex items-center gap-2 text-sm" htmlFor="bulk-edit-clear">
                        <input id="bulk-edit-clear" data-testid="bulk-edit-clear" type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} />
                        {t('sites.wide_bulk_clear')}
                      </label>
                      {clear ? <p className="mt-1 text-xs text-mute" data-testid="bulk-edit-clear-hint">{t('sites.wide_bulk_clear_note')}</p> : <>
                      <label className="block text-sm font-semibold" htmlFor="bulk-edit-value">{t('sites.wide_bulk_value')}</label>
                      {kind === 'list' || kind === 'boolean' ? (
                        <select id="bulk-edit-value" data-testid="bulk-edit-value" data-input={kind} className="input w-full" value={draft} onChange={(e) => setDraft(e.target.value)}>
                          <option value="">{t('sites.wide_bulk_choose')}</option>
                          {kind === 'boolean' ? <><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></> : options.map((o) => <option key={o.value} value={o.value}>{label(o)}</option>)}
                        </select>
                      ) : (
                        kind === 'date'
                          ? <DateInput id="bulk-edit-value" data-testid="bulk-edit-value" data-input={kind} className="input w-full" value={draft} onChange={(e) => setDraft(e.target.value)} />
                          : <input id="bulk-edit-value" data-testid="bulk-edit-value" data-input={kind} type={kind} step={kind === 'number' ? 'any' : undefined} className="input w-full" value={draft} onChange={(e) => setDraft(e.target.value)} />
                      )}
                      {kind === 'list' && anyMissingParent(rows, ord) && <p className="mt-1 text-xs text-mute" data-testid="bulk-edit-parent-hint">{t('sites.wide_bulk_pick_parent')}</p>}
                      </>}
                    </div>
                  )}
                  {plan && (
                    <div data-testid="bulk-edit-preview" aria-live="polite" className="rounded border border-line p-2 text-sm">
                      <b>{t('sites.wide_bulk_preview', { change: plan.change.length, skipped: plan.skipped.length })}</b>
                      {skipList}
                    </div>
                  )}
                </>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" className="btn" data-testid="bulk-edit-cancel" onClick={() => onClose()}>{t('common.cancel')}</button>
                <button type="button" className="btn btn-accent" data-testid="bulk-edit-confirm" disabled={!plan || !plan.change.length} onClick={() => void confirm()}>{t('sites.wide_bulk_confirm')}</button>
              </div>
            </>
          )}
          {phase === 'running' && <p role="status" data-testid="bulk-edit-progress">{t('sites.wide_bulk_saving', { done, total: snap?.change.length ?? 0 })}</p>}
          {phase === 'done' && (
            <>
              <div data-testid="bulk-edit-result" aria-label={t('sites.wide_bulk_result')} className="space-y-1 text-sm">
                <p>{header(ord)}</p>
                <p data-testid="bulk-edit-saved">{t('sites.wide_bulk_saved', { count: savedCount })}</p>
                <p data-testid="bulk-edit-skipped">{t('sites.wide_bulk_skipped', { count: snap?.skipped.length ?? 0 })}</p>
                {skipList}
                <p data-testid="bulk-edit-failed">{t('sites.wide_bulk_failed', { count: failed.length })}</p>
                {failed.length > 0 && (
                  <ul className="list-disc ps-5 text-xs text-lateInk" data-testid="bulk-edit-failures">
                    {failed.map((f) => <li key={f.code}><b className="mono">{f.code}</b>: {reasonOf(f)}</li>)}
                  </ul>
                )}
              </div>
              <div className="flex justify-end"><button type="button" className="btn btn-accent" data-testid="bulk-edit-close" onClick={() => onClose(failed.map((f) => f.code))}>{t('common.close')}</button></div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
