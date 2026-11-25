import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BATCH_CONFIRM_ABOVE, countChanges, type BatchDraft } from '@/lib/batchDraft';

export type BatchResult = { id: string; label: string; status: 'saved' | 'conflict' | 'failed'; message?: string };

/**
 * The pending-changes bar of the batch edit: how many edits wait, Review (every edit, old and new value, the conflicts and refusals of the last save),
 * Save all and Discard all. Above BATCH_CONFIRM_ABOVE edits Save all asks once more. A save is partial: the records that saved leave the draft, the others stay.
 */
export function BatchEditBar({ draft, results, busy, fieldLabel, valueText, onSave, onDiscard, onExit }: {
  draft: BatchDraft; results: BatchResult[]; busy: boolean; fieldLabel: (code: string) => string; valueText: (code: string, v: unknown) => string;
  onSave: () => void; onDiscard: () => void; onExit: () => void;
}) {
  const { t } = useTranslation();
  const [review, setReview] = useState(false);
  const [ask, setAsk] = useState(false);
  const n = countChanges(draft);
  const recs = Object.keys(draft.changes).length;
  const bad = results.filter((r) => r.status !== 'saved');
  return (
    <section className="card space-y-2 p-3" data-testid="batch-bar" aria-label={t('batch.title')}>
      <div className="flex flex-wrap items-center gap-2">
        <b data-testid="batch-count">{t('batch.pending', { count: n, records: recs })}</b>
        <span className="me-auto text-xs text-mute">{t('batch.note')}</span>
        <button type="button" className="btn" data-testid="batch-review" disabled={!n && !bad.length} onClick={() => setReview((x) => !x)}>{t('batch.review')}</button>
        <button type="button" className="btn btn-accent" data-testid="batch-save" disabled={!n || busy} onClick={() => (n > BATCH_CONFIRM_ABOVE ? setAsk(true) : onSave())}>{t('batch.save_all')}</button>
        <button type="button" className="btn" data-testid="batch-discard" disabled={!n || busy} onClick={onDiscard}>{t('batch.discard_all')}</button>
        <button type="button" className="btn" data-testid="batch-exit" disabled={busy} onClick={onExit}>{t('batch.exit')}</button>
      </div>
      {ask && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded bg-waitBg p-2 text-sm text-waitInk" data-testid="batch-confirm">
          {t('batch.confirm_many', { count: n })}
          <button type="button" className="btn btn-accent" data-testid="batch-confirm-yes" onClick={() => { setAsk(false); onSave(); }}>{t('batch.save_all')}</button>
          <button type="button" className="btn" onClick={() => setAsk(false)}>{t('common.cancel')}</button>
        </div>
      )}
      {bad.length > 0 && (
        <ul className="list-disc ps-5 text-sm text-lateInk" data-testid="batch-problems">
          {bad.map((r) => <li key={r.id}><b>{r.label}</b>: {r.status === 'conflict' ? t('batch.conflict') : r.message}</li>)}
        </ul>
      )}
      {review && (
        <table className="w-full text-sm" data-testid="batch-review-list">
          <thead className="text-mute"><tr><th className="p-1 text-start">{t('batch.record')}</th><th className="p-1 text-start">{t('batch.field')}</th><th className="p-1 text-start">{t('batch.was')}</th><th className="p-1 text-start">{t('batch.now')}</th></tr></thead>
          <tbody>
            {Object.entries(draft.changes).flatMap(([id, r]) => Object.entries(r.set).map(([code, c]) => (
              <tr key={`${id}-${code}`} className="border-t border-line" data-testid={`batch-row-${id}-${code}`}>
                <td className="p-1">{r.label}</td><td className="p-1">{fieldLabel(code)}</td><td className="p-1 text-mute">{valueText(code, c.from) || '-'}</td><td className="p-1 font-semibold">{valueText(code, c.to) || '-'}</td>
              </tr>
            )))}
          </tbody>
        </table>
      )}
    </section>
  );
}
