import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '@/api/client';
import {
  useImportAliases, useSaveAlias, useSaveMapping, useTemplateMapping,
  type ImportAlias, type TemplateMappingChange, type TemplateMappingResult, type TemplateTaskField,
} from '@/api/masterImport';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { registerErrorMessage } from '@/lib/registerErrors';

const TABS = ['fields', 'role', 'region'] as const;
type Tab = (typeof TABS)[number];
const fieldErrors = (e: unknown): string[] => (e instanceof ApiError && Array.isArray(e.problem.errors) ? e.problem.errors.map((x) => `${x.path}: ${x.message}`) : []);

/**
 * Q207 (contract 0.12.8): the template mapping screen, and Q8 / Q10: the role and region aliases of the import. Every change needs a reason; a test runs the
 * change and shows its impact without saving; a save issues the next template versions. The database refuses a calculated field as a typed column.
 */
export function TemplateMappingPage() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(sp.get('tab') ?? '') ? (sp.get('tab') as Tab) : 'fields';
  return (
    <div data-testid="page-template-mapping">
      <PageHeader title={t('tmap.title')} subtitle={t('tmap.subtitle')} />
      <div role="tablist" className="mb-3 flex gap-1">
        {TABS.map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} data-testid={`tmap-tab-${x}`} className={`btn px-3 py-1 text-sm ${tab === x ? 'btn-primary' : ''}`}
            onClick={() => setSp((p) => { const n = new URLSearchParams(p); n.set('tab', x); return n; }, { replace: true })}>{t(`tmap.tab_${x}`)}</button>
        ))}
      </div>
      {tab === 'fields' ? <FieldsTab /> : <AliasesTab kind={tab} />}
    </div>
  );
}

function FieldsTab() {
  const { t } = useTranslation();
  const m = useTemplateMapping();
  const [edit, setEdit] = useState<Partial<TemplateTaskField> | null>(null);
  if (m.isLoading) return <LoadingSkeleton />;
  if (!m.data) return <ErrorState onRetry={() => void m.refetch()} />;
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <p className="text-sm text-mute">{t('tmap.fields_hint')}</p>
        {m.data.can_edit && <button className="btn btn-primary ms-auto px-2 py-1 text-xs" data-testid="tmap-add" onClick={() => setEdit({ field_type: 'text', read_only: false })}>{t('tmap.add')}</button>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm" data-testid="tmap-fields">
          <thead className="bg-card2 text-mute"><tr>{['task', 'field', 'label', 'master', 'scenarios', 'projection', 'typed', ''].map((c) => <th key={c} className="p-2 text-start">{c ? t(`tmap.col_${c}`) : ''}</th>)}</tr></thead>
          <tbody>
            {m.data.fields.map((f) => (
              <tr key={`${f.task_code}:${f.field_key}`} className={`border-t border-line ${f.is_active ? '' : 'text-mute line-through'}`} data-testid={`tmap-field-${f.task_code}-${f.field_key}`}>
                <td className="mono p-2">{f.task_code}</td>
                <td className="mono p-2">{f.field_key}</td>
                <td className="p-2">{f.label}</td>
                <td className="p-2">{f.master_col ? <><span className="mono">{f.master_col}</span> <span className="text-mute">{f.master_header}</span></> : '—'}</td>
                <td className="p-2 text-mute">{f.scenarios?.length ? f.scenarios.map((s) => t(`scenario.${s}`, { defaultValue: s })).join(', ') : t('tmap.all_scenarios')}</td>
                <td className="p-2">{f.projection ? t(`tmap.proj_${f.projection}`) : '—'}</td>
                <td className="p-2">{f.read_only ? t('tmap.grey') : t('tmap.typed')}</td>
                <td className="p-2">{m.data.can_edit && <button className="btn px-2 py-1 text-xs" data-testid={`tmap-edit-${f.task_code}-${f.field_key}`} onClick={() => setEdit(f)}>{t('common.edit')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <FieldDialog field={edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function FieldDialog({ field, onClose }: { field: Partial<TemplateTaskField>; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useSaveMapping();
  const [v, setV] = useState({ task_code: field.task_code ?? '', field_key: field.field_key ?? '', label: field.label ?? '', master_col: field.master_col ?? '',
    read_only: field.read_only ?? false, projection: field.projection ?? '', field_type: field.field_type ?? 'text', active: field.is_active ?? true });
  const [reason, setReason] = useState('');
  const [impact, setImpact] = useState<TemplateMappingResult | null>(null);
  const [errs, setErrs] = useState<string[]>([]);
  const change = (): TemplateMappingChange => (v.active
    ? { op: 'upsert', task_code: v.task_code.trim(), field_key: v.field_key.trim(), label: v.label.trim(), field_type: v.field_type as TemplateMappingChange['field_type'],
        master_col: v.master_col.trim() || null, read_only: v.read_only, projection: (v.projection || null) as TemplateMappingChange['projection'], options: field.options ?? null, scenarios: field.scenarios ?? null }
    : { op: 'deactivate', task_code: v.task_code.trim(), field_key: v.field_key.trim() });
  const run = (dry: boolean) => save.mutate({ changes: [change()], reason, dry_run: dry }, {
    onSuccess: (r) => { setErrs([]); if (dry) setImpact(r); else { toast(t('tmap.saved')); onClose(); } },
    onError: (e) => { setImpact(null); setErrs(fieldErrors(e).length ? fieldErrors(e) : [registerErrorMessage(t, e)]); },
  });
  const isNew = !field.task_code;
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="tmap-dialog" className="card fixed inset-x-0 top-[8vh] z-[70] mx-auto max-h-[84vh] w-[min(560px,94vw)] space-y-3 overflow-y-auto p-5">
          <Dialog.Title className="text-lg font-bold">{isNew ? t('tmap.add') : `${field.task_code} · ${field.field_key}`}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute">{t('tmap.dialog_hint')}</Dialog.Description>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">{t('tmap.col_task')}<input className="input mt-1 w-full" data-testid="tmap-task" disabled={!isNew} value={v.task_code} onChange={(e) => setV({ ...v, task_code: e.target.value })} /></label>
            <label className="text-sm">{t('tmap.col_field')}<input className="input mt-1 w-full" data-testid="tmap-key" disabled={!isNew} value={v.field_key} onChange={(e) => setV({ ...v, field_key: e.target.value })} /></label>
            <label className="text-sm">{t('tmap.col_label')}<input className="input mt-1 w-full" data-testid="tmap-label" value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} /></label>
            <label className="text-sm">{t('tmap.col_master')}<input className="input mt-1 w-full" data-testid="tmap-master" value={v.master_col} onChange={(e) => setV({ ...v, master_col: e.target.value.toUpperCase() })} /></label>
            <label className="text-sm">{t('tmap.col_projection')}
              <select className="input mt-1 w-full" data-testid="tmap-projection" value={v.projection} onChange={(e) => setV({ ...v, projection: e.target.value })}>
                <option value="">—</option><option value="earliest">{t('tmap.proj_earliest')}</option><option value="latest">{t('tmap.proj_latest')}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="tmap-readonly" checked={v.read_only} onChange={(e) => setV({ ...v, read_only: e.target.checked })} />{t('tmap.grey')}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="tmap-active" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} />{t('tmap.active')}</label>
          </div>
          <label className="block text-sm font-semibold">{t('mi.reason')}<textarea className="input mt-1 w-full" data-testid="tmap-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          {errs.length > 0 && <ul role="alert" className="list-disc ps-5 text-sm text-lateInk" data-testid="tmap-errors">{errs.map((x) => <li key={x}>{x}</li>)}</ul>}
          {impact && (
            <div className="rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="tmap-impact">
              <p className="font-semibold">{impact.impact.length ? t('tmap.impact_title') : t('tmap.no_impact')}</p>
              <ul className="list-disc ps-5">
                {impact.impact.map((i) => (
                  <li key={i.template_id} data-testid={`tmap-impact-${i.template_id}`}>
                    {t('tmap.impact_line', { id: i.template_id, from: i.version_before, to: i.version_after, added: (i.columns_added ?? []).join(', ') || '—', removed: (i.columns_removed ?? []).join(', ') || '—', open: i.open_batches ?? 0 })}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn" data-testid="tmap-test" disabled={reason.trim().length < 3 || save.isPending} onClick={() => run(true)}>{t('tmap.test')}</button>
            <button className="btn btn-primary" data-testid="tmap-save" disabled={reason.trim().length < 3 || save.isPending} onClick={() => run(false)}>{t('common.save')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AliasesTab({ kind }: { kind: 'role' | 'region' }) {
  const { t } = useTranslation();
  const toast = useToast();
  const list = useImportAliases(kind);
  const save = useSaveAlias();
  const [v, setV] = useState({ alias: '', label: '', target: '', status: 'unmapped', reason: '' });
  const [errs, setErrs] = useState<string[]>([]);
  const pick = (a: ImportAlias) => setV({ alias: a.alias, label: a.label, target: a.target ?? '', status: a.status === 'mapped' ? 'unmapped' : a.status, reason: '' });
  const send = () => save.mutate({ kind, alias: v.alias, label: v.label || v.alias, target: v.target || null, is_active: true, ...(kind === 'role' && !v.target ? { status: v.status as 'ambiguous' | 'unmapped' } : {}), reason: v.reason }, {
    onSuccess: () => { toast(t('tmap.saved')); setErrs([]); setV({ alias: '', label: '', target: '', status: 'unmapped', reason: '' }); },
    onError: (e) => setErrs(fieldErrors(e).length ? fieldErrors(e) : [registerErrorMessage(t, e)]),
  });
  if (list.isLoading) return <LoadingSkeleton />;
  if (!list.data) return <ErrorState onRetry={() => void list.refetch()} />;
  return (
    <section className="space-y-3">
      <p className="text-sm text-mute">{t(`tmap.${kind}_hint`)}</p>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm" data-testid={`tmap-aliases-${kind}`}>
          <thead className="bg-card2 text-mute"><tr>{['value', 'target', 'status', 'note', ''].map((c) => <th key={c} className="p-2 text-start">{c ? t(`tmap.acol_${c}`) : ''}</th>)}</tr></thead>
          <tbody>
            {list.data.items.map((a) => (
              <tr key={a.alias} className="border-t border-line" data-testid={`tmap-alias-${a.alias}`} data-status={a.status}>
                <td className="p-2 font-semibold">{a.label}</td>
                <td className="p-2">{a.target_name ?? '—'}</td>
                <td className="p-2"><span className={`chip ${a.status === 'mapped' ? 'bg-doneBg text-doneInk' : 'bg-lateBg text-lateInk'}`}>{t(`tmap.status_${a.status}`)}</span></td>
                <td className="p-2 text-mute">{a.note ?? ''}</td>
                <td className="p-2">{list.data.can_edit && <button className="btn px-2 py-1 text-xs" data-testid={`tmap-alias-edit-${a.alias}`} onClick={() => pick(a)}>{t('common.edit')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.data.items.length && <EmptyState title={t('tmap.no_aliases')} />}
      </div>
      {list.data.can_edit && (
        <form className="card grid gap-2 p-3 sm:grid-cols-2" data-testid={`tmap-alias-form-${kind}`} onSubmit={(e) => { e.preventDefault(); send(); }}>
          <label className="text-sm">{t('tmap.acol_value')}<input className="input mt-1 w-full" data-testid="alias-value" value={v.alias} onChange={(e) => setV({ ...v, alias: e.target.value })} /></label>
          <label className="text-sm">{t(kind === 'role' ? 'tmap.target_role' : 'tmap.target_region')}<input className="input mt-1 w-full" data-testid="alias-target" value={v.target} onChange={(e) => setV({ ...v, target: e.target.value })} /></label>
          {kind === 'role' && !v.target && (
            <label className="text-sm">{t('tmap.acol_status')}
              <select className="input mt-1 w-full" data-testid="alias-status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>
                <option value="unmapped">{t('tmap.status_unmapped')}</option><option value="ambiguous">{t('tmap.status_ambiguous')}</option>
              </select>
            </label>
          )}
          <label className="text-sm sm:col-span-2">{t('mi.reason')}<input className="input mt-1 w-full" data-testid="alias-reason" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></label>
          {errs.length > 0 && <ul role="alert" className="list-disc ps-5 text-sm text-lateInk sm:col-span-2" data-testid="alias-errors">{errs.map((x) => <li key={x}>{x}</li>)}</ul>}
          <div className="sm:col-span-2 flex justify-end"><button type="submit" className="btn btn-primary" data-testid="alias-save" disabled={!v.alias.trim() || v.reason.trim().length < 3 || save.isPending}>{t('common.save')}</button></div>
        </form>
      )}
    </section>
  );
}
