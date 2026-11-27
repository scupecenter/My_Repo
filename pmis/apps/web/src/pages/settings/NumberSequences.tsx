import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNumberSequences, useSaveNumberSequence, type SequencePatch } from '@/api/numberSequences';
import type { NumberSequence } from '@/api/types';
import { InlinePanel } from '@/components/InlinePanel';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { useMe } from '@/api/hooks';
import { isAdmin } from '@/lib/perm';
import { registerErrorMessage } from '@/lib/registerErrors';

type Form = { pattern: string; reset: 'never' | 'yearly'; next_value: string; region_code: string; is_active: boolean };
const formOf = (s: NumberSequence): Form => ({ pattern: s.pattern, reset: s.reset, next_value: String(s.next_value), region_code: s.region_code ?? '', is_active: s.is_active !== false });

/**
 * Settings, Documents, Numbering (Q106): the numbering sequences (DN, RN, PL, OPEN, ADJ and the forms) with their next number. The System Admin or a
 * delegate of settings edit changes the pattern, the reset, the next value, the region code and the active flag, with a reason; the database function checks
 * the pattern, the version and writes the audit. Nothing is deleted, and a new sequence is not made here.
 */
export function NumberSequences() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useNumberSequences();
  const save = useSaveNumberSequence();
  const admin = isAdmin(useMe(true).data);
  const [row, setRow] = useState<NumberSequence | null>(null);
  const [f, setF] = useState<Form | null>(null);
  if (!q.data) return <QueryFallback queries={[q]} testid="seq-loading" />;
  const open = (s: NumberSequence) => { setRow(s); setF(formOf(s)); save.reset(); };
  const close = () => { setRow(null); setF(null); };
  const diff = (s: NumberSequence, x: Form): SequencePatch => {
    const p: SequencePatch = {}, o = formOf(s);
    if (x.pattern !== o.pattern) p.pattern = x.pattern.trim();
    if (x.reset !== o.reset) p.reset = x.reset;
    if (x.next_value !== o.next_value) p.next_value = Number(x.next_value);
    if (x.region_code !== o.region_code) p.region_code = x.region_code.trim() === '' ? null : x.region_code.trim().toUpperCase();
    if (x.is_active !== o.is_active) p.is_active = x.is_active;
    return p;
  };
  const patch = row && f ? diff(row, f) : {};
  const badNext = !!f && !/^[1-9][0-9]{0,8}$/.test(f.next_value.trim());
  return (
    <section className="card space-y-3 p-4" data-testid="page-number-sequences">
      <h2 className="font-bold">{t('seq.title')}</h2>
      <p className="text-sm text-mute">{t('seq.note')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-mute">{['key', 'for', 'pattern', 'reset', 'next', 'preview', 'active'].map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(`seq.col_${c}`)}</th>)}<th /></tr></thead>
          <tbody>
            {q.data.map((s) => (
              <tr key={s.key} className="border-b border-line last:border-0" data-testid={`seq-row-${s.key}`}>
                <td className="mono px-3 py-2" dir="ltr">{s.key}</td>
                <td className="px-3 py-2">{(s.record_type ?? s.form_kind ?? '').toUpperCase()}{s.region_code ? ` · ${s.region_code}` : ''}</td>
                <td className="mono px-3 py-2" dir="ltr">{s.pattern}</td>
                <td className="px-3 py-2">{t(`seq.reset_${s.reset}`)}</td>
                <td className="px-3 py-2" dir="ltr">{s.next_value}</td>
                <td className="mono px-3 py-2" dir="ltr">{s.next_preview ?? '—'}</td>
                <td className="px-3 py-2">{t(s.is_active === false ? 'wh.no' : 'wh.yes')}</td>
                <td className="px-3 py-2 text-end">{admin && <button className="btn" data-testid={`seq-edit-${s.key}`} onClick={() => open(s)}>{t('common.edit')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {row && f && (
        <InlinePanel testid="seq-panel" title={t('seq.edit_title', { key: row.key })} onClose={close} busy={save.isPending} disabled={Object.keys(patch).length === 0 || badNext || f.pattern.trim() === ''}
          error={save.isError ? registerErrorMessage(t, save.error) : null}
          onSubmit={(reason) => save.mutate({ key: row.key, version: row.version, patch, reason }, { onSuccess: () => { toast(t('settings.audited')); close(); } })}>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm font-semibold">{t('seq.col_pattern')}
              <input className="input mono mt-1" dir="ltr" data-testid="seq-pattern" value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} />
              <span className="mt-1 block text-xs font-normal text-mute">{t('seq.pattern_help')}</span>
            </label>
            <label className="text-sm font-semibold">{t('seq.col_reset')}
              <select className="input mt-1" data-testid="seq-reset" value={f.reset} onChange={(e) => setF({ ...f, reset: e.target.value as Form['reset'] })}>
                <option value="yearly">{t('seq.reset_yearly')}</option><option value="never">{t('seq.reset_never')}</option>
              </select>
            </label>
            <label className="text-sm font-semibold">{t('seq.col_next')}
              <input className="input mt-1" dir="ltr" inputMode="numeric" data-testid="seq-next" aria-invalid={badNext} value={f.next_value} onChange={(e) => setF({ ...f, next_value: e.target.value })} />
              <span className="mt-1 block text-xs font-normal text-mute">{t('seq.next_help')}</span>
            </label>
            <label className="text-sm font-semibold">{t('seq.region_code')}
              <input className="input mono mt-1" dir="ltr" data-testid="seq-region" value={f.region_code} onChange={(e) => setF({ ...f, region_code: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" data-testid="seq-active" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />{t('seq.col_active')}</label>
          </div>
        </InlinePanel>
      )}
    </section>
  );
}
