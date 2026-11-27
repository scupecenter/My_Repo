import { Plus, X } from 'lucide-react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeriveRules, useSetDeriveRules, type DeriveRule } from '@/api/p4c';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { QueryFallback } from '@/components/States';

/**
 * Settings, Registers, derived values between registers (contract 0.15.260). Each rule shows a value of a source register in a target register (only that value,
 * computed on read, never stored). The two rules of GECOL and HLC (contractor from Procurement) are the seed.
 */
export function DeriveRulesScreen() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useDeriveRules(), set = useSetDeriveRules();
  const [draft, setDraft] = useState<DeriveRule[] | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <section className="card p-4" data-testid="page-derive"><QueryFallback queries={[q]} testid="derive-loading" /></section>;
  const cur = draft ?? (q.data.rules as DeriveRule[]);
  const regs = q.data.registers;
  const fieldsOf = (k: string) => regs.find((r) => r.register_key === k)?.fields ?? [];
  const lbl = (f: { code: string; label_en: string; label_ar?: string | null }) => (i18n.language === 'ar' && f.label_ar) || f.label_en;
  const edit = (i: number, patch: Partial<DeriveRule>) => setDraft(cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const blank = (): DeriveRule => ({ key: `rule_${cur.length + 1}`, enabled: false, target_register: regs[0]?.register_key ?? '', output: `value_${cur.length + 1}`, source_register: regs[1]?.register_key ?? '', source: 'external_party', link_field: null });
  const invalid = cur.some((r) => !r.target_register || !r.source_register || r.target_register === r.source_register);

  return (
    <section className="card space-y-3 p-4" data-testid="page-derive">
      <h2 className="font-bold">{t('deriveRules.title')}</h2>
      <p className="text-sm text-mute">{t('deriveRules.note')}</p>
      <p className="mono text-xs text-mute" data-testid="derive-version">{t('scopeMatch.version', { version: q.data.version })}{draft && <span className="chip ms-2">{t('scopeMatch.unsaved')}</span>}</p>
      {cur.map((r, i) => (
        <fieldset key={i} className="grid gap-2 rounded-md border border-line p-2 md:grid-cols-3" data-testid={`derive-rule-${i}`}>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" data-testid={`derive-enabled-${i}`} checked={r.enabled} onChange={(e) => edit(i, { enabled: e.target.checked })} />{t('deriveRules.enabled')}
            <span className="mono text-xs font-normal text-mute">{r.key}</span>
          </label>
          <label className="text-sm">{t('deriveRules.target')}
            <select className="input mt-1" data-testid={`derive-target-${i}`} value={r.target_register} onChange={(e) => edit(i, { target_register: e.target.value, link_field: null })}>
              {regs.map((x) => <option key={x.register_key} value={x.register_key}>{x.register_key}</option>)}
            </select>
          </label>
          <label className="text-sm">{t('deriveRules.output')}
            <input className="input mt-1" data-testid={`derive-output-${i}`} value={r.output} onChange={(e) => edit(i, { output: e.target.value })} />
          </label>
          <label className="text-sm">{t('deriveRules.source_register')}
            <select className="input mt-1" data-testid={`derive-source-register-${i}`} value={r.source_register} onChange={(e) => edit(i, { source_register: e.target.value, source: 'external_party' })}>
              {regs.map((x) => <option key={x.register_key} value={x.register_key}>{x.register_key}</option>)}
            </select>
          </label>
          <label className="text-sm">{t('deriveRules.source')}
            <select className="input mt-1" data-testid={`derive-source-${i}`} value={r.source} onChange={(e) => edit(i, { source: e.target.value })}>
              <option value="external_party">{t('deriveRules.source_party')}</option>
              {fieldsOf(r.source_register).map((f) => <option key={f.code} value={f.code}>{lbl(f)}</option>)}
            </select>
          </label>
          <label className="text-sm">{t('deriveRules.link')}
            <select className="input mt-1" data-testid={`derive-link-${i}`} value={r.link_field ?? ''} onChange={(e) => edit(i, { link_field: e.target.value || null })}>
              <option value="">{t('deriveRules.link_none')}</option>
              {fieldsOf(r.target_register).map((f) => <option key={f.code} value={f.code}>{lbl(f)}</option>)}
            </select>
          </label>
          {r.link_field && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" data-testid={`derive-fallback-${i}`} checked={r.site_fallback === true} onChange={(e) => edit(i, { site_fallback: e.target.checked })} />{t('deriveRules.site_fallback')}
            </label>
          )}
          <button type="button" className="btn btn-ghost text-sm" data-testid={`derive-remove-${i}`} onClick={() => setDraft(cur.filter((_, j) => j !== i))}><X size={14} />{t('deriveRules.remove')}</button>
        </fieldset>
      ))}
      <div className="flex gap-2">
        <button type="button" className="btn" data-testid="derive-add" disabled={cur.length >= 60} onClick={() => setDraft([...cur, blank()])}><Plus size={14} />{t('deriveRules.add')}</button>
        <button className="btn btn-accent" data-testid="derive-save" disabled={!draft || invalid} onClick={() => setOpen(true)}>{t('scopeMatch.save')}</button>
      </div>
      <UnsavedGuard scope="settings" dirty={!!draft} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: q.data!.version, body: { rules: cur, reason } }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="derive-dialog" title={t('deriveRules.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: q.data!.version, body: { rules: cur, reason } }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })} />
      )}
    </section>
  );
}
