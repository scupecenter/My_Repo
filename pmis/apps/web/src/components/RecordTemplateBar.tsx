import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRecordTemplateOps, useRecordTemplates } from '@/api/recordTemplates';
import { useRegisterRecords } from '@/api/registers';
import type { RegisterDefinition, RegisterRecord } from '@/api/types';
import { copyableData, recordName } from '@/lib/recordTemplate';
import { useToast } from './Toast';

/**
 * Item 8, on the record form. A new record: "Start from" a saved template of yours or a previous record of the register; it fills plain values (text, number, list,
 * yes/no) and the record type, nothing else, and nothing is saved until the person submits, so every right and rule of the normal create still applies. An existing
 * record: "Save as template" keeps those values under a name for this register. Templates are personal.
 */
export function RecordTemplateBar({ def, record, onApply }: { def: RegisterDefinition; record: RegisterRecord | null; onApply: (data: Record<string, unknown>, recordType: string | null) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const key = def.register_key;
  const isNew = !record;
  const tpls = useRecordTemplates(key, isNew);
  const prev = useRegisterRecords(key, { q: '', region_id: '', state: '', record_type: '' }, isNew);
  const ops = useRecordTemplateOps(key);
  const [name, setName] = useState('');
  const [naming, setNaming] = useState(false);
  if (isNew) {
    const recs = (prev.data?.pages.flatMap((p) => p.items) ?? []).slice(0, 20);
    if (!tpls.data?.length && !recs.length) return null;
    return (
      <label className="flex flex-wrap items-center gap-2 text-sm" data-testid="start-from">
        <span className="text-mute">{t('recTpl.start_from')}</span>
        <select className="input w-auto py-1" value="" data-testid="start-from-select" aria-label={t('recTpl.start_from')}
          onChange={(e) => {
            const v = e.target.value; if (!v) return;
            const tp = tpls.data?.find((x) => `t:${x.id}` === v);
            if (tp) { onApply(tp.data, tp.record_type); return; }
            const r = recs.find((x) => `r:${x.id}` === v);
            if (r) onApply(copyableData(def, r.data), r.record_type ?? null);
          }}>
          <option value="">—</option>
          {!!tpls.data?.length && <optgroup label={t('recTpl.mine')}>{tpls.data.map((x) => <option key={x.id} value={`t:${x.id}`}>{x.name}</option>)}</optgroup>}
          {!!recs.length && <optgroup label={t('recTpl.previous')}>{recs.map((r) => <option key={r.id} value={`r:${r.id}`}>{recordName(def, r)}</option>)}</optgroup>}
        </select>
      </label>
    );
  }
  const save = () => {
    const n = name.trim();
    if (!n) return;
    ops.save.mutate({ register_key: key, name: n, record_type: record.record_type ?? null, data: copyableData(def, record.data) }, {
      onSuccess: () => { setName(''); setNaming(false); toast(t('recTpl.saved'), 'ok'); },
      onError: (e) => toast(e.status === 409 ? t('recTpl.exists') : t('common.error'), 'err'),
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="save-template">
      {!naming ? <button type="button" className="btn px-2 py-1 text-xs" data-testid="save-template-open" onClick={() => setNaming(true)}>{t('recTpl.save_as')}</button> : (
        <>
          <input className="input w-48 py-1 text-xs" maxLength={60} value={name} placeholder={t('recTpl.name')} aria-label={t('recTpl.name')} data-testid="save-template-name"
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
          <button type="button" className="btn btn-accent px-2 py-1 text-xs" data-testid="save-template-go" disabled={!name.trim() || ops.save.isPending} onClick={save}>{t('recTpl.save')}</button>
          <button type="button" className="btn px-2 py-1 text-xs" onClick={() => { setNaming(false); setName(''); }}>{t('common.cancel')}</button>
        </>
      )}
    </div>
  );
}
