import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { useRegisterDefs } from '@/api/registers';
import { useDuplicateRowsSettings, useSetDuplicateRowsSettings } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { Tip } from '@/components/Tip';
import { useToast } from '@/components/Toast';

type Mode = 'first' | 'last';

/**
 * Settings, Data > Imports: "Duplicate rows in one file" (contract 0.15.345, migration 0432, setting imports.duplicate_rows). Off by default (first row wins, as before). When a register is set to
 * "last", the later row of a record that is in the file twice wins and the earlier row is set aside, listed in the batch review and the error report, never lost. A default for every register and an
 * override per register. Covers register templates; master, sites, stream, list-values and holiday templates are not covered. Read by everyone; changed with a reason by a System Admin or an all-regions delegate of settings.
 */
export function DuplicateRowsCard() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useDuplicateRowsSettings(), set = useSetDuplicateRowsSettings(), defs = useRegisterDefs();
  const [def, setDef] = useState<Mode | null>(null);
  const [regs, setRegs] = useState<Record<string, Mode> | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="duprows-loading" />;
  const cur = q.data;
  const mode = def ?? cur.default;
  const over = regs ?? (cur.registers as Record<string, Mode>);
  const dirty = mode !== cur.default || JSON.stringify(Object.entries(over).sort()) !== JSON.stringify(Object.entries(cur.registers).sort());
  const ar = i18n.language === 'ar';
  const setReg = (key: string, v: string) => {
    const next = { ...over };
    if (v === 'default') delete next[key]; else next[key] = v as Mode;
    setRegs(next);
  };
  return (
    <section className="card mt-4 space-y-3 p-4" data-testid="page-duprows-settings">
      <h2 className="font-bold">{t('dupRows.title')}</h2>
      <p className="text-sm text-mute">{t('dupRows.note')}</p>
      <div>
        <label htmlFor="duprows-default" className="text-sm font-semibold">{t('dupRows.default')}</label>
        <select id="duprows-default" className="input ms-2" data-testid="duprows-default" value={mode} disabled={!cur.can_edit} onChange={(e) => setDef(e.target.value as Mode)}>
          <option value="first">{t('dupRows.first')}</option>
          <option value="last">{t('dupRows.last')}</option>
        </select>
        <Tip text={t('dupRows.hint')}><span className="ms-2 inline-flex align-middle text-mute" tabIndex={0} role="img" aria-label={t('dupRows.hint')}><Info size={14} aria-hidden /></span></Tip>
      </div>
      <details data-testid="duprows-registers">
        <summary className="cursor-pointer text-sm font-semibold">{t('dupRows.per_register', { count: Object.keys(over).length })}</summary>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {(defs.data ?? []).map((d) => (
            <li key={d.register_key} className="flex items-center justify-between gap-2 text-sm">
              <label htmlFor={`duprows-${d.register_key}`}>{ar ? (d.name_ar || d.name_en) : d.name_en}</label>
              <select id={`duprows-${d.register_key}`} className="input py-1" data-testid={`duprows-reg-${d.register_key}`} value={over[d.register_key] ?? 'default'} disabled={!cur.can_edit} onChange={(e) => setReg(d.register_key, e.target.value)}>
                <option value="default">{t('dupRows.use_default')}</option>
                <option value="first">{t('dupRows.first')}</option>
                <option value="last">{t('dupRows.last')}</option>
              </select>
            </li>
          ))}
        </ul>
      </details>
      <p className="text-xs text-mute">{t('dupRows.excluded')}</p>
      {cur.can_edit
        ? <button className="btn btn-accent" data-testid="duprows-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>
        : <p className="text-sm text-mute" data-testid="duprows-readonly">{t('importsSettings.readonly')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="duprows-dialog" title={t('dupRows.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, default: mode, registers: over, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDef(null); setRegs(null); } })}>
          <p className="text-sm text-mute">{t('dupRows.confirm', { mode: t(mode === 'last' ? 'dupRows.last' : 'dupRows.first') })}</p>
        </FormDialog>
      )}
    </section>
  );
}
