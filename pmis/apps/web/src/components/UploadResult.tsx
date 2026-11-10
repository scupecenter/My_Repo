import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { batchPath, type ImportBatch, type UploadedBatch } from '@/api/types';

/**
 * What an upload produced: for a TPL-MASTER file the batch of each part, then the warnings (columns and sheets GSDN Workspace does not own, parts that were
 * skipped). Shown by the upload dialog (a file staged in the request) and by the batch page once a big file was staged in the background (0.15.3).
 */
export function UploadResult({ result, onOpen }: { result: UploadedBatch; onOpen?: () => void }) {
  const { t } = useTranslation();
  const partName = (p: ImportBatch) => (p.stream ? t(`tpl.stream_${p.stream}`, { defaultValue: p.stream }) : p.part_sheet ?? p.register_key ?? p.template_id);
  return (
    <>
      {!!result.parts?.length && (
        <div>
          <p className="font-semibold">{t('tpl.parts_title', { count: result.parts.length })}</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm" data-testid="template-upload-parts">
            {result.parts.map((p) => (
              <li key={p.id} data-testid={`upload-part-${p.id}`}>
                <Link className="font-semibold underline" to={batchPath(p)} onClick={onOpen}>{partName(p)}</Link>
                <span className="text-mute"> · {p.part_sheet} · {t('batch.diff', { create: p.counts.create ?? 0, update: p.counts.update ?? 0, unchanged: p.counts.unchanged ?? 0 })}{!!p.counts.error && ` · ${t('batch.invalid', { count: p.counts.error })}`}{!!p.counts.held && ` · ${t('batch.held_count', { count: p.counts.held })}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!result.warnings?.length && (
        <div role="status" className="rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="template-upload-warnings">
          <p className="font-semibold">{t('tpl.warnings_title', { count: result.warnings.length })}</p>
          <ul className="mt-1 list-disc ps-5">
            {result.warnings.map((w, i) => (
              <li key={`${w.code}-${w.sheet ?? ''}-${w.column ?? ''}-${i}`} data-testid={`upload-warning-${w.code}`}>
                {t(`tpl.warn_${w.code}`, { sheet: w.sheet ?? '', column: w.column ?? '', count: w.count ?? 0, defaultValue: w.message })}
                {w.code === 'part_skipped' && <span className="block text-xs">{w.message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
