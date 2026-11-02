import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSetTeamScopeMatch, useTeamScopeMatch } from '@/api/settings';
import type { TeamScopeMatchInput } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

type Draft = { specializations: string[]; scopes: { scope: string; exempt: boolean; allowed: string[] }[] };
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Settings, team / scope match of Procurement (contract 0.9.1, Q97): a grid of scopes x specializations, plus an exempt flag per scope. */
export function TeamScopeMatch() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useTeamScopeMatch(), set = useSetTeamScopeMatch();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newSpec, setNewSpec] = useState('');
  const [newScope, setNewScope] = useState('');
  const [open, setOpen] = useState(false);
  const cur: Draft | null = draft ?? (q.data ? { specializations: q.data.specializations, scopes: q.data.scopes.map((s) => ({ scope: s.scope, exempt: s.exempt ?? false, allowed: s.allowed })) } : null);
  const errs = fieldErrors(set.error);
  if (!cur) return <section className="card p-4" data-testid="page-team-scope">…</section>;

  const toggle = (scope: string, spec: string, on: boolean) => setDraft({
    ...cur, scopes: cur.scopes.map((s) => (s.scope !== scope ? s : { ...s, allowed: on ? [...s.allowed, spec] : s.allowed.filter((x) => !same(x, spec)) })),
  });
  const addSpec = () => {
    const v = newSpec.trim();
    if (!v || cur.specializations.some((x) => same(x, v))) return;
    setDraft({ ...cur, specializations: [...cur.specializations, v] }); setNewSpec('');
  };
  const addScope = () => {
    const v = newScope.trim();
    if (!v || cur.scopes.some((s) => s.scope === v)) return;
    setDraft({ ...cur, scopes: [...cur.scopes, { scope: v, exempt: false, allowed: [] }] }); setNewScope('');
  };
  const body: TeamScopeMatchInput = cur;

  return (
    <section className="card space-y-3 p-4" data-testid="page-team-scope">
      <h2 className="font-bold">{t('scopeMatch.title')}</h2>
      <p className="text-sm text-mute">{t('scopeMatch.note')}</p>
      <p className="mono text-xs text-mute" data-testid="tsm-version">{t('scopeMatch.version', { version: q.data?.version })}{draft && <span className="chip ms-2">{t('scopeMatch.unsaved')}</span>}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="tsm-grid">
          <thead className="text-mute">
            <tr>
              <th className="p-2 text-start">{t('scopeMatch.scope')}</th>
              <th className="p-2 text-center">{t('scopeMatch.exempt')}</th>
              {cur.specializations.map((sp) => (
                <th key={sp} className="p-2 text-center" data-testid={`tsm-col-${sp}`}>
                  <span className="inline-flex items-center gap-1">{sp}
                    <button type="button" className="btn btn-ghost p-0.5" aria-label={t('scopeMatch.remove', { name: sp })} data-testid={`tsm-remove-col-${sp}`}
                      onClick={() => setDraft({ specializations: cur.specializations.filter((x) => x !== sp), scopes: cur.scopes.map((s) => ({ ...s, allowed: s.allowed.filter((x) => !same(x, sp)) })) })}><X size={12} /></button>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cur.scopes.map((s, i) => (
              <tr key={s.scope} className="border-t border-line" data-testid={`tsm-row-${s.scope}`}>
                <td className="p-2">
                  <span className="inline-flex items-center gap-1">{s.scope}
                    <button type="button" className="btn btn-ghost p-0.5" aria-label={t('scopeMatch.remove', { name: s.scope })} data-testid={`tsm-remove-row-${s.scope}`}
                      onClick={() => setDraft({ ...cur, scopes: cur.scopes.filter((x) => x.scope !== s.scope) })}><X size={12} /></button>
                  </span>
                  {errs[`/scopes/${i}/scope`] && <p role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs[`/scopes/${i}/scope`]}`)}</p>}
                </td>
                <td className="p-2 text-center">
                  <input type="checkbox" data-testid={`tsm-exempt-${s.scope}`} aria-label={`${s.scope}: ${t('scopeMatch.exempt')}`} checked={s.exempt}
                    onChange={(e) => setDraft({ ...cur, scopes: cur.scopes.map((x) => (x.scope === s.scope ? { ...x, exempt: e.target.checked } : x)) })} />
                </td>
                {cur.specializations.map((sp) => (
                  <td key={sp} className="p-2 text-center">
                    <input type="checkbox" data-testid={`tsm-cell-${s.scope}-${sp}`} disabled={s.exempt} aria-label={t('scopeMatch.cell', { specialization: sp, scope: s.scope })}
                      checked={!s.exempt && s.allowed.some((x) => same(x, sp))} onChange={(e) => toggle(s.scope, sp, e.target.checked)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-semibold">{t('scopeMatch.new_specialization')}
          <input className="input mt-1 font-normal" data-testid="tsm-new-spec" maxLength={60} value={newSpec} onChange={(e) => setNewSpec(e.target.value)} /></label>
        <button type="button" className="btn" data-testid="tsm-add-spec" onClick={addSpec}><Plus size={14} />{t('scopeMatch.add_specialization')}</button>
        <label className="text-sm font-semibold">{t('scopeMatch.new_scope')}
          <input className="input mt-1 font-normal" data-testid="tsm-new-scope" maxLength={60} value={newScope} onChange={(e) => setNewScope(e.target.value)} /></label>
        <button type="button" className="btn" data-testid="tsm-add-scope" onClick={addScope}><Plus size={14} />{t('scopeMatch.add_scope')}</button>
      </div>
      <button className="btn btn-accent" data-testid="tsm-save" disabled={!draft || !q.data} onClick={() => setOpen(true)}>{t('scopeMatch.save')}</button>
      {open && q.data && (
        <FormDialog open onClose={() => setOpen(false)} testid="tsm-dialog" title={t('scopeMatch.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: q.data.version, body: { ...body, reason } }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })} />
      )}
    </section>
  );
}
