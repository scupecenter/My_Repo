import { CircleStop } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useDecideBatch } from '@/api/registers';
import { batchPath, type UploadedBatch } from '@/api/types';
import { registerErrorMessage } from '@/lib/registerErrors';
import { BatchProgress } from './BatchProgress';
import { useToast } from './Toast';
import { UploadResult } from './UploadResult';

/**
 * 0.15.3: the batch page of a big upload staged in the background. While the file is checked it shows the real progress (rows checked of the file's rows,
 * the part being staged) and lets the uploader stop it; once staged, a one-batch file opens its batch, a TPL-MASTER file lists the batches of its parts and
 * the warnings; a check that ended without a batch says why.
 */
export function UploadStaging({ batch: b, routeId }: { batch: UploadedBatch; routeId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const decide = useDecideBatch();
  const staged = b.id !== routeId;
  const single = staged && !(b.parts?.length || b.warnings?.length);
  useEffect(() => { if (single) navigate(batchPath(b), { replace: true }); }, [single, b, navigate]);
  const stop = () => decide.mutate({ batch: b, req: { action: 'discard', scope: 'all' } }, {
    onSuccess: () => toast(t('upload.stopped')),
    onError: (e) => { const m = registerErrorMessage(t, e); if (m) toast(m, 'err'); },
  });
  return (
    <div data-testid="page-upload" data-status={b.status} data-staged={staged ? 'yes' : 'no'}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{t('upload.title')}</h1>
          <p className="text-mute">{b.file_name} · {b.template_id} v{b.template_version}</p>
        </div>
        <Link className="btn" data-testid="upload-back" to="/templates">{t('tpl.back')}</Link>
      </div>
      {b.status === 'parsing' && !staged && (
        <>
          <BatchProgress batch={b} />
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-card2 p-3 text-sm">
            <span className="flex-1">{t('upload.hint')}</span>
            <button className="btn" data-testid="upload-stop" disabled={decide.isPending} onClick={stop}><CircleStop size={16} />{t('upload.stop')}</button>
          </div>
        </>
      )}
      {b.status === 'failed' && !staged && (
        <div role="alert" data-testid="upload-failed" className="rounded-md bg-lateBg p-3 text-sm text-lateInk">
          <p className="font-semibold">{b.upload?.error?.code === 'stopped' ? t('upload.stopped') : t('upload.failed')}</p>
          {b.upload?.error?.detail && <p className="mt-1" data-testid="upload-failed-detail">{b.upload.error.detail}</p>}
          {!!b.upload?.batch_ids?.length && <p className="mt-1 text-xs">{t('upload.failed_parts', { count: b.upload.batch_ids.length })}</p>}
        </div>
      )}
      {staged && !single && (
        <div className="space-y-3" data-testid="upload-done">
          <p className="font-semibold" role="status">{t('upload.done')}</p>
          <UploadResult result={b} />
        </div>
      )}
    </div>
  );
}
