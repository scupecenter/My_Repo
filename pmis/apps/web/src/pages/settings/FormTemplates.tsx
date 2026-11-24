import { CheckCircle2, Upload, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiError } from '@/api/client';
import { useFormTemplates, useTemplateOps, type LibraryFormTemplate } from '@/api/library';
import { FormDialog } from '@/components/FormDialog';
import { EmptyState, QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';

const errText = (e: ApiError | null | undefined) => (e ? (e.problem?.errors?.map((x) => `${x.path}: ${x.message}`).join(' ') || e.problem?.detail || e.message) : '');
const TONE: Record<string, string> = { draft: 'bg-waitBg text-waitInk', approved: 'bg-doneBg text-doneInk', retired: 'bg-lockBg text-lockInk' };

/** "owner = site.tower_owner" lines to an object; null when a line does not read. */
export function parseBindings(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([a-z][a-z0-9_]{0,40})\s*=\s*([a-z_][a-z0-9_.]{0,120})$/.exec(line);
    if (!m) return null;
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

/**
 * Settings > Documents > Form templates (W5, contract 0.15.70): upload a form or a new version (a draft), approve it (it replaces the version in force; a
 * step-up), retire it. System Admin or an all-regions delegate of the Document Library; the server checks the HTML against the allow-list of printable forms.
 */
export function FormTemplates() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useFormTemplates();
  const ops = useTemplateOps();
  const [f, setF] = useState({ code: '', name_en: '', name_ar: '', doc_code: '', trigger_task_code: '', numbering_pattern: '', numbering_reset: 'yearly' as 'yearly' | 'never', bindings: '' });
  const [file, setFile] = useState<File | null>(null);
  const [act, setAct] = useState<{ kind: 'approve' | 'retire'; tpl: LibraryFormTemplate } | null>(null);
  const [uploading, setUploading] = useState(false);
  const bind = parseBindings(f.bindings);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const ready = f.code && f.name_en && f.doc_code && f.trigger_task_code && f.numbering_pattern && file && bind;
  const startNew = (tpl: LibraryFormTemplate) => {
    setF({ code: tpl.code, name_en: tpl.name_en, name_ar: tpl.name_ar ?? '', doc_code: tpl.doc_code, trigger_task_code: tpl.trigger_task_code, numbering_pattern: tpl.numbering_pattern,
      numbering_reset: tpl.numbering_reset ?? 'yearly', bindings: Object.entries(tpl.bindings ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n') });
    document.getElementById('ft-form')?.scrollIntoView({ behavior: 'smooth' });
  };
  if (!q.data) return <QueryFallback queries={[q]} />;
  const field = (k: keyof typeof f, label: string, extra: Record<string, unknown> = {}) => (
    <label className="block text-sm font-semibold">{label}<input className="input mt-1 w-full" data-testid={`ft-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} {...extra} /></label>
  );
  return (
    <div className="space-y-4" data-testid="settings-form-templates">
      <div><h2 className="font-bold">{t('ft.title')}</h2><p className="text-sm text-mute">{t('ft.note')}</p></div>
      {!q.data.length ? <EmptyState testid="ft-empty" title={t('ft.none')} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm" data-testid="ft-table">
            <thead className="bg-card2 text-mute"><tr>{['col_code', 'col_name', 'col_version', 'col_doc', 'col_trigger', 'col_numbering', 'col_updated'].map((c) => <th key={c} className="p-2 text-start">{t(`lib.${c}`)}</th>)}<th className="p-2" /></tr></thead>
            <tbody>
              {q.data.map((x) => (
                <tr key={x.id} className="border-t border-line" data-testid={`ft-row-${x.code}-v${x.version}`} data-status={x.status}>
                  <td className="mono p-2">{x.code}</td>
                  <td className="p-2">{(i18n.language === 'ar' && x.name_ar) || x.name_en}<span className="ms-1 text-xs text-mute">{t('ft.placeholders', { count: x.placeholders?.length ?? 0 })}</span></td>
                  <td className="p-2">v{x.version} <span className={`chip ${TONE[x.status] ?? ''}`}>{t(`ft.status.${x.status}`)}</span></td>
                  <td className="mono p-2">{x.doc_code}</td>
                  <td className="mono p-2">{x.trigger_task_code}</td>
                  <td className="mono p-2 text-xs">{x.numbering_pattern}</td>
                  <td className="p-2 text-mute">{String(x.updated_at).slice(0, 10)}</td>
                  <td className="p-2"><span className="flex flex-wrap gap-1">
                    {x.status === 'draft' && <button type="button" className="btn btn-primary px-2 py-1 text-xs" data-testid={`ft-approve-${x.code}-v${x.version}`} onClick={() => setAct({ kind: 'approve', tpl: x })}><CheckCircle2 size={14} />{t('ft.approve')}</button>}
                    {x.status !== 'retired' && <button type="button" className="btn px-2 py-1 text-xs" data-testid={`ft-retire-${x.code}-v${x.version}`} onClick={() => setAct({ kind: 'retire', tpl: x })}><XCircle size={14} />{t('ft.retire')}</button>}
                    <button type="button" className="btn px-2 py-1 text-xs" data-testid={`ft-newversion-${x.code}-v${x.version}`} onClick={() => startNew(x)}>{t('ft.new_version', { code: x.code })}</button>
                  </span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form id="ft-form" className="card grid gap-3 p-4 sm:grid-cols-2" data-testid="ft-form" onSubmit={(e) => e.preventDefault()}>
        {field('code', t('ft.code'), { maxLength: 41, placeholder: 'SSR' })}
        {field('doc_code', t('ft.doc_code'), { maxLength: 40 })}
        {field('name_en', t('ft.name_en'), { maxLength: 200 })}
        {field('name_ar', t('ft.name_ar'), { maxLength: 200, dir: 'rtl' })}
        {field('trigger_task_code', t('ft.trigger'), { maxLength: 40 })}
        <label className="block text-sm font-semibold">{t('ft.pattern')}<input className="input mono mt-1 w-full" data-testid="ft-numbering_pattern" value={f.numbering_pattern} placeholder="SSR-{YYYY}-{SEQ:4}" onChange={(e) => set('numbering_pattern', e.target.value)} />
          <span className="text-xs font-normal text-mute">{t('ft.pattern_hint')}</span></label>
        <label className="block text-sm font-semibold">{t('ft.reset')}
          <select className="input mt-1 w-full" data-testid="ft-reset" value={f.numbering_reset} onChange={(e) => set('numbering_reset', e.target.value)}>
            <option value="yearly">{t('ft.reset_yearly')}</option><option value="never">{t('ft.reset_never')}</option>
          </select></label>
        <label className="block text-sm font-semibold">{t('ft.file')}<input type="file" className="mt-1 block text-sm" accept=".html,.htm,text/html" data-testid="ft-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <label className="block text-sm font-semibold sm:col-span-2">{t('ft.bindings')}
          <textarea className="input mono mt-1 w-full" rows={3} data-testid="ft-bindings" value={f.bindings} onChange={(e) => set('bindings', e.target.value)} />
          <span className="text-xs font-normal text-mute">{bind ? t('ft.bindings_hint') : t('ft.bindings_invalid')}</span></label>
        <div className="sm:col-span-2"><button type="button" className="btn btn-primary" data-testid="ft-upload" disabled={!ready || uploading} onClick={() => setUploading(true)}><Upload size={14} />{t('ft.upload')}</button></div>
      </form>
      <FormDialog open={uploading} onClose={() => setUploading(false)} title={t('ft.upload')} testid="ft-upload-dialog" busy={ops.upload.isPending} error={ops.upload.isError ? errText(ops.upload.error) : null}
        onSubmit={(reason) => file && bind && ops.upload.mutate({ ...f, bindings: bind, reason, file }, { onSuccess: () => { setUploading(false); setFile(null); toast(t('ft.uploaded')); } })} />
      <FormDialog open={!!act} onClose={() => setAct(null)} title={act ? `${t(`ft.${act.kind}`)} ${act.tpl.code} v${act.tpl.version}` : ''} testid="ft-action-dialog"
        busy={ops.approve.isPending || ops.retire.isPending} error={(act?.kind === 'approve' ? ops.approve : ops.retire).isError ? errText((act?.kind === 'approve' ? ops.approve : ops.retire).error) : null}
        onSubmit={(reason) => act && (act.kind === 'approve' ? ops.approve : ops.retire).mutate({ id: act.tpl.id, reason }, { onSuccess: () => { toast(t(act.kind === 'approve' ? 'ft.approved' : 'ft.retired')); setAct(null); } })} />
    </div>
  );
}
