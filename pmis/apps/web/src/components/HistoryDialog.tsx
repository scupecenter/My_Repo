import { useTranslation } from 'react-i18next';
import type { HistoryEntry } from '@/api/history';
import { FormDialog } from '@/components/FormDialog';

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** History/FieldHistory of one record (hardening layer 1c): who changed which field from what to what, newest first. `onRestore` offers Restore on an entry; it goes through the normal writer (rights, locks, reason, audit). */
export function HistoryDialog({ title, testid, entries, loading, onClose, onRestore }: {
  title: string; testid: string; entries: HistoryEntry[] | undefined; loading: boolean; onClose: () => void;
  onRestore?: (e: HistoryEntry) => void;
}) {
  const { t } = useTranslation();
  return (
    <FormDialog open wide withReason={false} title={title} testid={testid} onClose={onClose} onSubmit={onClose} submitLabel={t('common.close')}>
      {loading && <p className="text-mute">{t('common.loading')}</p>}
      {entries && !entries.length && <p className="text-mute" data-testid={`${testid}-empty`}>{t('history.empty')}</p>}
      <ul className="max-h-[60vh] space-y-2 overflow-auto">
        {(entries ?? []).map((e) => (
          <li key={e.id} className="card p-2 text-sm" data-testid={`${testid}-entry`}>
            <div className="flex flex-wrap items-center gap-2">
              <b>{e.action}</b>
              <span className="text-mute">{new Date(e.at).toLocaleString()}</span>
              {e.actor?.display_name && <span>{e.actor.display_name}</span>}
              {onRestore && e.changes.length > 0 && <button type="button" className="btn ms-auto px-2 py-1 text-xs" data-testid={`${testid}-restore`} onClick={() => onRestore(e)}>{t('history.restore')}</button>}
            </div>
            {e.reason && <p className="text-mute">{e.reason}</p>}
            {e.changes.length > 0 && (
              <ul className="mt-1">{e.changes.map((c) => <li key={c.field} className="mono text-xs">{c.field}: {show(c.from)} → {show(c.to)}</li>)}</ul>
            )}
          </li>
        ))}
      </ul>
    </FormDialog>
  );
}
