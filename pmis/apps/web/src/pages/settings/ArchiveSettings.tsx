import { ArrowDown, ArrowUp } from 'lucide-react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiError } from '@/api/client';
import { ARCHIVE_COLUMNS, useArchive, useArchiveSetting, useSaveArchiveSetting } from '@/api/library';
import { FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { DocumentMarksSettings } from './DocumentMarksSettings';
import { useToast } from '@/components/Toast';

type Col = (typeof ARCHIVE_COLUMNS)[number];
const errText = (e: ApiError | null | undefined) => (e ? (e.problem?.errors?.map((x) => `${x.path}: ${x.message}`).join(' ') || e.problem?.detail || e.message) : '');

/**
 * Settings > Documents > Archive (W5-2 and W5-6, contract 0.15.70): which cards Library > Archive shows and in what order, the default columns of its list and
 * the bulk zip limit. System Admin or an all-regions delegate of admin.settings, a reason, If-Match; audited by the server.
 */
export function ArchiveSettings() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const s = useArchiveSetting();
  const cards = useArchive();
  const save = useSaveArchiveSetting();
  const [draft, setDraft] = useState<{ order: string[]; hidden: string[]; cols: Col[]; zip: string } | null>(null);
  const [saving, setSaving] = useState(false);
  if (!s.data || !cards.data) return <QueryFallback queries={[s, cards]} />;
  const known = cards.data.groups.flatMap((g) => g.cards);
  const nameOf = (code: string) => { const c = known.find((x) => x.doc_code === code); return c ? (i18n.language === 'ar' && c.name_ar) || c.name_en : code; };
  const base = { order: [...s.data.order, ...known.map((c) => c.doc_code).filter((c) => !s.data!.order.includes(c))], hidden: [...s.data.hidden], cols: [...s.data.default_columns] as Col[], zip: String(s.data.zip_limit) };
  const d = draft ?? base;
  const move = (i: number, by: number) => { const o = [...d.order]; const j = i + by; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j]!, o[i]!]; setDraft({ ...d, order: o }); };
  const zip = Number(d.zip);
  const valid = Number.isInteger(zip) && zip >= 1 && zip <= 5000 && d.cols.length > 0;
  return (
    <div className="space-y-4" data-testid="settings-library-archive">
      <div><h2 className="font-bold">{t('as.title')}</h2><p className="text-sm text-mute">{t('as.note')}</p></div>
      <fieldset className="card p-3"><legend className="px-1 font-semibold">{t('as.cards')}</legend>
        {!d.order.length ? <p className="text-sm text-mute">{t('as.no_cards')}</p> : (
          <ol className="space-y-1">
            {d.order.map((code, i) => (
              <li key={code} className="flex items-center gap-2 text-sm" data-testid={`as-card-${code}`}>
                <input type="checkbox" aria-label={`${t('as.show')}: ${nameOf(code)}`} data-testid={`as-show-${code}`} checked={!d.hidden.includes(code)}
                  onChange={(e) => setDraft({ ...d, hidden: e.target.checked ? d.hidden.filter((x) => x !== code) : [...d.hidden, code] })} />
                <span className="mono w-28">{code}</span><span className="flex-1">{nameOf(code)}</span>
                <button type="button" className="btn px-1.5 py-0.5" aria-label={t('as.up')} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                <button type="button" className="btn px-1.5 py-0.5" aria-label={t('as.down')} disabled={i === d.order.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
              </li>
            ))}
          </ol>)}
      </fieldset>
      <fieldset className="card p-3"><legend className="px-1 font-semibold">{t('as.columns')}</legend>
        <div className="flex flex-wrap gap-3">
          {ARCHIVE_COLUMNS.map((c) => (
            <label key={c} className="flex items-center gap-1 text-sm"><input type="checkbox" data-testid={`as-col-${c}`} checked={d.cols.includes(c)}
              onChange={(e) => setDraft({ ...d, cols: e.target.checked ? ARCHIVE_COLUMNS.filter((x) => x === c || d.cols.includes(x)) : d.cols.filter((x) => x !== c) })} />{t(`lib.col.${c}`)}</label>
          ))}
        </div>
      </fieldset>
      <DocumentMarksSettings types={known.map((c) => ({ code: c.doc_code, name: nameOf(c.doc_code) }))} />
      <label className="block max-w-xs text-sm font-semibold">{t('as.zip_limit')}<input type="number" min={1} max={5000} className="input mt-1 w-full" data-testid="as-zip" value={d.zip} onChange={(e) => setDraft({ ...d, zip: e.target.value })} /></label>
      <UnsavedGuard scope="settings" dirty={!!draft && valid} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => save.mutate({ hidden: d.hidden, order: d.order, default_columns: d.cols, zip_limit: zip, reason, version: s.data!.version }, { onSuccess: () => { setDraft(null); res(true); }, onError: () => res(false) }))} />
      <button type="button" className="btn btn-primary" data-testid="as-save" disabled={!valid || !draft} onClick={() => setSaving(true)}>{t('as.save')}</button>
      <FormDialog open={saving} onClose={() => setSaving(false)} title={t('as.title')} testid="as-save-dialog" busy={save.isPending} error={save.isError ? errText(save.error) : null}
        onSubmit={(reason) => save.mutate({ hidden: d.hidden, order: d.order, default_columns: d.cols, zip_limit: zip, reason, version: s.data!.version },
          { onSuccess: () => { setSaving(false); setDraft(null); toast(t('as.saved')); } })} />
    </div>
  );
}
