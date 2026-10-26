import * as Dialog from '@radix-ui/react-dialog';
import { Download } from 'lucide-react';
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { downloadExport, useExportParts, useExports, useStartExport } from '@/api/admin';
import { ApiError } from '@/api/client';
import type { ExportPartKey, MasterExport, MasterExportRequest } from '@/api/types';
import { useRegions } from '@/api/sites';
import { errText } from './FormDialog';
import { ScopePicker } from './ScopePicker';
import { useToast } from './Toast';

const TONE: Record<string, string> = { queued: 'bg-lockBg text-lockInk', running: 'bg-openBg text-openInk', done: 'bg-doneBg text-doneInk', failed: 'bg-lateBg text-lateInk', expired: 'bg-lockBg text-lockInk' };
const TODAY = '2026-10-25';

/** Message for a failed export start: a 403 lists the parts the caller may not export; a 422 lists the field problems. */
export function exportError(e: unknown, t: TFunction, label: (k: string) => string) {
  if (e instanceof ApiError && e.status === 403 && e.problem.errors?.length) return t('export.denied', { parts: e.problem.errors.map((x) => label(x.path.split('/').pop() ?? '')).join(', ') });
  if (e instanceof ApiError && e.status === 422) return t('export.invalid', { fields: (e.problem.errors ?? []).map((x) => `${x.path} ${x.code}`).join('; ') });
  return errText(e, t);
}

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const ar = i18n.language === 'ar';
  const parts = useExportParts(open), list = useExports(open), regions = useRegions(), start = useStartExport();
  const [kind, setKind] = useState<'whole' | 'parts'>('whole');
  const [picked, setPicked] = useState<ExportPartKey[]>([]);
  const [reg, setReg] = useState<'all' | number[]>('all');
  const [asOf, setAsOf] = useState('');
  const label = (k: string) => { const p = parts.data?.find((x) => x.key === k); return p ? (ar ? p.label_ar : p.label_en) : k; };
  const bad = (kind === 'parts' && !picked.length) || (reg !== 'all' && !reg.length);
  const go = () => {
    const body: MasterExportRequest = { ...(kind === 'parts' ? { parts: picked } : {}), ...(reg !== 'all' ? { regions: reg } : {}), ...(asOf ? { as_of: asOf } : {}) };
    start.mutate(body, { onSuccess: () => toast(t('export.started')) });
  };
  const dl = (e: MasterExport) => downloadExport(e.id).catch((x) => toast(x instanceof ApiError && x.code === 'export_expired' ? t('errors.export_expired') : t('errors.generic'), 'err'));
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="export-dialog" className="card fixed inset-x-0 top-[5vh] z-[70] mx-auto max-h-[90vh] w-[min(760px,94vw)] space-y-3 overflow-y-auto p-5">
          <Dialog.Title className="text-lg font-bold">{t('export.title')}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute">{t('export.body')}</Dialog.Description>
          <div role="radiogroup" aria-label={t('export.title')} className="flex flex-col gap-1 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="export-kind" data-testid="export-kind-whole" checked={kind === 'whole'} onChange={() => setKind('whole')} />{t('export.whole')}</label>
            <label className="flex items-center gap-2"><input type="radio" name="export-kind" data-testid="export-kind-parts" checked={kind === 'parts'} onChange={() => setKind('parts')} />{t('export.parts')}</label>
          </div>
          {kind === 'parts' && (
            <div className="card grid max-h-48 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto p-2 text-sm" data-testid="export-parts">
              {(parts.data ?? []).map((p) => (
                <label key={p.key} className="flex items-center gap-2"><input type="checkbox" data-testid={`export-part-${p.key}`} checked={picked.includes(p.key)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.key] : picked.filter((x) => x !== p.key))} />{ar ? p.label_ar : p.label_en}</label>
              ))}
            </div>
          )}
          <ScopePicker id="export-regions" label={t('export.regions')} options={(regions.data ?? []).map((r): [number, string] => [r.id, (ar && r.name_ar) || r.name_en])} value={reg} onChange={setReg} />
          <label className="block text-sm font-semibold">{t('export.as_of')}<input type="date" max={TODAY} className="input mt-1 w-auto font-normal" data-testid="export-as-of" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
          {start.isError && <p role="alert" data-testid="export-error" className="text-lateInk">{exportError(start.error, t, label)}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>{t('common.close')}</button>
            <button className="btn btn-accent" data-testid="export-start" disabled={bad || start.isPending} onClick={go}>{t('export.start')}</button>
          </div>
          <h3 className="font-bold">{t('export.mine')}</h3>
          <ul className="divide-y divide-line" data-testid="export-list">
            {(list.data ?? []).map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid={`export-row-${e.id}`}>
                <span className="font-semibold">{t(`export.kind_${e.kind}`)}</span>
                {e.kind === 'partial' && <span className="text-mute">{(e.parts ?? []).map(label).join(', ')}</span>}
                {e.kind === 'view' && <span className="text-mute">{label(e.view?.source ?? '')}</span>}
                <span className="mono text-xs text-mute">{e.created_at.slice(0, 16).replace('T', ' ')}</span>
                <span className={`chip ${TONE[e.status]}`} data-testid={`export-status-${e.id}`}>{t(`export.status_${e.status}`)}</span>
                <span className="flex-1" />
                {e.status === 'done' && <button className="btn" data-testid={`export-download-${e.id}`} onClick={() => void dl(e)}><Download size={14} />{t('export.download')}</button>}
              </li>
            ))}
            {list.isSuccess && !(list.data ?? []).length && <li className="py-2 text-mute" data-testid="export-none">{t('export.none')}</li>}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** "Export current view": sends exactly the filters and columns the list shows. */
export function ExportViewButton({ source, filters, columns, sort, testid }: { source: ExportPartKey; filters: Record<string, unknown>; columns: string[]; sort?: string; testid: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const start = useStartExport();
  const label = (k: string) => k;
  return (
    <button className="btn" data-testid={testid} disabled={start.isPending} onClick={() => start.mutate({ view: { source, filters, columns, ...(sort ? { sort } : {}) } }, {
      onSuccess: () => toast(t('export.view_started')), onError: (e) => toast(exportError(e, t, label), 'err'),
    })}><Download size={16} />{t('export.view')}</button>
  );
}
