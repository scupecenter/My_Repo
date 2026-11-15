import { useTranslation } from 'react-i18next';
import type { ImportBatch } from '@/api/types';

/** Contract 0.15.13: a file made from an older version of a register template is read by its column codes; this is the summary shown before the confirm. */
export function OlderTemplateNote({ info }: { info: NonNullable<ImportBatch['older_template']> }) {
  const { t } = useTranslation();
  const list = (rows: { key?: string; header?: string | null }[] | undefined) => (rows ?? []).map((r) => r.header || r.key || "").join(', ');
  const removed = info.removed_columns ?? [], added = info.added_columns ?? [], renamed = info.renamed_columns ?? [];
  return (
    <div role="status" className="card mb-3 space-y-1 border-s-4 border-s-lateInk p-3 text-sm" data-testid="batch-older-template">
      <p className="font-semibold">{t('batch.older_title', { file: info.file_version, current: info.current_version })}</p>
      {removed.length > 0 && <p data-testid="batch-older-removed">{t('batch.older_removed', { count: removed.length, list: list(removed) })}</p>}
      {added.length > 0 && <p data-testid="batch-older-added">{t('batch.older_added', { count: added.length, list: list(added) })}</p>}
      {renamed.length > 0 && <p data-testid="batch-older-renamed">{t('batch.older_renamed', { count: renamed.length, list: renamed.map((r) => `${r.from ?? r.key} → ${r.to ?? r.key}`).join(', ') })}</p>}
      <p className="text-mute">{t('batch.older_note')}</p>
    </div>
  );
}
