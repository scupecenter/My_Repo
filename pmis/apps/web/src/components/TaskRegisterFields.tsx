import { useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useCreateRecord, useNewVersion, useRegisterDefs, useUpdateRecord } from '@/api/registers';
import type { RegisterRecord, TaskRegisterField } from '@/api/types';
import { registerErrorMessage } from '@/lib/registerErrors';
import { FieldHistory } from './logs/FieldHistory';
import { useToast } from './Toast';

const EDITABLE = ['text', 'number', 'date', 'list', 'yes_no'];

function Row({ f, siteId }: { f: TaskRegisterField; siteId: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast(), qc = useQueryClient();
  const defs = useRegisterDefs();
  const { register_key: key, record_id: rid, record_version: ver, record_type } = f.source;
  const create = useCreateRecord(key), patch = useUpdateRecord(key), newVer = useNewVersion(key);
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState<unknown>(f.value ?? '');
  const ar = i18n.language === 'ar';
  const reg = defs.data?.find((d) => d.register_key === key);
  const regName = (ar && reg?.name_ar) || reg?.name_en || key;
  const canEdit = f.editable && f.edit_via !== 'none' && EDITABLE.includes(f.type);
  const shown = f.value === null || f.value === undefined || f.value === '' ? '—' : f.type === 'yes_no' ? (f.value ? t('common.yes') : t('common.no')) : String((f.options?.find((o) => o.value === f.value)?.label_en) ?? f.value);
  const data = { [f.source.field.replace(/^data\./, '')]: v === '' ? null : v };

  // The three write paths are the existing register endpoints; the tasks are refetched on success, the hooks roll their own optimistic edits back.
  const save = async () => {
    try {
      const stub = { id: rid, version: ver } as RegisterRecord;
      if (f.edit_via === 'create') await create.mutateAsync({ site_id: siteId, ...(record_type ? { record_type } : {}), data: data as Record<string, unknown> });
      else {
        const base = f.edit_via === 'new_version' ? await newVer.mutateAsync(stub) : stub;
        await patch.mutateAsync({ record: base, patch: { data } });
      }
      setEdit(false);
      toast(t('regFields.saved'));
    } catch (e) { const m = registerErrorMessage(t, e); if (m) toast(m, 'err'); }
    void qc.invalidateQueries({ queryKey: ['site-tasks', siteId] });
  };
  const busy = create.isPending || patch.isPending || newVer.isPending;
  const id = `regfield-${f.code}`;
  return (
    <li data-testid={id} data-edit-via={f.edit_via} className="rounded-md border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <b>{(ar && f.label_ar) || f.label_en}</b>
        {rid ? <Link className="chip bg-card2 text-accent" data-testid={`${id}-source`} to={`/registers/${key}?record=${rid}`}>{t('regFields.from', { register: regName })}</Link>
          : <span className="chip bg-card2" data-testid={`${id}-source`}>{t('regFields.from', { register: regName })}</span>}
        <FieldHistory entityType="register_record" entityId={rid} field={f.source.field.replace(/^data\./, '')} label={(ar && f.label_ar) || f.label_en} />
        {!canEdit && <span className="text-mute" data-testid={`${id}-readonly`}>{t('regFields.read_only')}</span>}
      </div>
      {edit ? (
        <div className="mt-2 flex gap-2">
          {f.type === 'list' && f.options?.length
            ? <select className="input" aria-label={f.label_en} data-testid={`${id}-input`} value={String(v)} onChange={(e) => setV(e.target.value)}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label_en}</option>)}</select>
            : f.type === 'yes_no' ? <input type="checkbox" role="switch" aria-label={f.label_en} data-testid={`${id}-input`} checked={v === true} onChange={(e) => setV(e.target.checked)} />
            : <input className="input" type={f.type === 'list' ? 'text' : f.type} aria-label={f.label_en} data-testid={`${id}-input`} value={String(v)} onChange={(e) => setV(f.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />}
          <button className="btn btn-primary" data-testid={`${id}-save`} disabled={busy} onClick={() => void save()}>{t('drawer.save')}</button>
          <button className="btn" onClick={() => { setEdit(false); setV(f.value ?? ''); }}>{t('common.cancel')}</button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2"><span data-testid={`${id}-value`} className="mono">{shown}</span>
          {canEdit && <button className="btn px-2 py-0.5" data-testid={`${id}-edit`} aria-label={t('regFields.edit')} onClick={() => { setV(f.value ?? ''); setEdit(true); }}><Pencil size={14} /></button>}
          {canEdit && f.edit_via === 'new_version' && <span className="text-xs text-mute">{t('regFields.new_version_note')}</span>}</div>
      )}
    </li>
  );
}

/** Register-owned fields of a task (contract 0.4.9): each one says where it comes from and is written through that register's own endpoints. */
export function TaskRegisterFields({ fields, siteId }: { fields: TaskRegisterField[]; siteId: string }) {
  const { t } = useTranslation();
  if (!fields.length) return null;
  return (
    <section aria-label={t('regFields.title')} data-testid="task-register-fields">
      <h3 className="mb-1 font-semibold">{t('regFields.title')}</h3>
      <ul className="space-y-2">{fields.map((f) => <Row key={f.code} f={f} siteId={siteId} />)}</ul>
    </section>
  );
}
