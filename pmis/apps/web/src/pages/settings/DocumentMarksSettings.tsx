import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiError } from '@/api/client';
import { useDocMarks, useSaveDocMark } from '@/api/documents';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';

const errText = (e: ApiError | null | undefined) => (e ? (e.problem?.errors?.map((x) => `${x.path}: ${x.message}`).join(' ') || e.problem?.detail || e.message) : '');

/**
 * Settings > Documents > Archive, second block (migration 0555): which document types need a signed copy and a stamped copy. The upload then asks whether
 * the file is that copy, the version shows the markers and the slot says "awaiting signed copy" until one carries them. Nothing is blocked. A reason is
 * required and the server audits each change (System Admin or a delegate of document types).
 */
export function DocumentMarksSettings({ types }: { types: { code: string; name: string }[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const marks = useDocMarks();
  const save = useSaveDocMark();
  const [draft, setDraft] = useState<Record<string, { signature: boolean; stamp: boolean }>>({});
  const [reason, setReason] = useState('');
  if (!marks.data) return <QueryFallback queries={[marks]} />;
  const cur = (code: string) => draft[code] ?? marks.data!.types[code] ?? { signature: false, stamp: false };
  const set = (code: string, k: 'signature' | 'stamp', v: boolean) => setDraft({ ...draft, [code]: { ...cur(code), [k]: v } });
  const changed = Object.keys(draft);
  const run = async () => {
    for (const code of changed) {
      try { await save.mutateAsync({ code, signature: draft[code]!.signature, stamp: draft[code]!.stamp, reason: reason.trim() }); } catch { return; }
    }
    setDraft({}); setReason(''); toast(t('marks.saved'));
  };
  return (
    <fieldset className="card p-3" data-testid="settings-doc-marks">
      <legend className="px-1 font-semibold">{t('marks.title')}</legend>
      <p className="mb-2 text-sm text-mute">{t('marks.note')}</p>
      <ul className="space-y-1">
        {types.map((x) => (
          <li key={x.code} className="flex flex-wrap items-center gap-3 text-sm" data-testid={`marks-row-${x.code}`}>
            <span className="mono w-28">{x.code}</span><span className="min-w-40 flex-1">{x.name}</span>
            <label className="flex items-center gap-1"><input type="checkbox" data-testid={`marks-signature-${x.code}`} checked={cur(x.code).signature} onChange={(e) => set(x.code, 'signature', e.target.checked)} />{t('marks.signature')}</label>
            <label className="flex items-center gap-1"><input type="checkbox" data-testid={`marks-stamp-${x.code}`} checked={cur(x.code).stamp} onChange={(e) => set(x.code, 'stamp', e.target.checked)} />{t('marks.stamp')}</label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-60 flex-1 text-sm font-semibold">{t('marks.reason')}<input className="input mt-1 w-full font-normal" data-testid="marks-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button type="button" className="btn btn-primary" data-testid="marks-save" disabled={!changed.length || reason.trim().length < 3 || save.isPending} onClick={() => void run()}>{t('marks.save')}</button>
      </div>
      {save.isError && <p className="mt-2 text-sm text-lateInk" role="alert" data-testid="marks-error">{errText(save.error)}</p>}
    </fieldset>
  );
}
