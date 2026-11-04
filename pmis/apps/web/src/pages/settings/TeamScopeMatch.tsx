import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSetTeamScopeMatch, useTeamScopeMatch } from '@/api/settings';
import type { SpecializationGroup, TeamScopeMatchInput, TeamSpecialization } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

type Row = { scope: string; exempt: boolean; allowed: string[]; allowed_groups: SpecializationGroup[] };
type Spec = TeamSpecialization & { is_new?: boolean };
type Draft = { specializations: string[]; catalogue: Spec[]; scopes: Row[] };
const GROUPS: SpecializationGroup[] = ['CW', 'TE'];
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s\p{P}]+/gu, '');

/**
 * Settings, team / scope match of Procurement (contract 0.9.1, Q97; 0.12.9, Q143, Q144, Q147). The rows are the order scopes; the columns are the
 * codes of the specialization catalogue, grouped by their functional group (CW, TE); a row may also allow a whole group. Procurement and Contractors
 * see the table read-only (`can_edit` false). A save that changes eligibility asks for a step-up (the client's step-up dialog answers the 401).
 */
export function TeamScopeMatch({ readOnly = false }: { readOnly?: boolean }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useTeamScopeMatch(), set = useSetTeamScopeMatch();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newSpec, setNewSpec] = useState('');
  const [newScope, setNewScope] = useState('');
  const [open, setOpen] = useState(false);
  const cur: Draft | null = draft ?? (q.data ? {
    specializations: q.data.specializations, catalogue: q.data.catalogue ?? [],
    scopes: q.data.scopes.map((s) => ({ scope: s.scope, exempt: s.exempt ?? false, allowed: s.allowed, allowed_groups: s.allowed_groups ?? [] })),
  } : null);
  const errs = fieldErrors(set.error);
  if (!cur) return <section className="card p-4" data-testid="page-team-scope">…</section>;
  const editable = !readOnly && !!q.data?.can_edit;
  const spec = (code: string) => cur.catalogue.find((c) => c.code === code);
  // 0.13.0 (Q292): a specialization may belong to both groups (Dismantle is CW and TE); `group` is only the first one
  const groupsOf = (code: string): SpecializationGroup[] => { const c = spec(code); return c?.groups ?? (c?.group ? [c.group] : []); };
  const label = (code: string) => { const c = spec(code); return (i18n.language === 'ar' && c?.label_ar) || c?.label_en || code; };
  // columns: CW group first, then TE, then the codes without a group
  const cols = [...cur.specializations].sort((a, b) => { const r = (c: string) => { const g = groupsOf(c)[0]; return g === 'CW' ? 0 : g === 'TE' ? 1 : 2; }; return r(a) - r(b); });

  const toggle = (scope: string, code: string, on: boolean) => setDraft({
    ...cur, scopes: cur.scopes.map((s) => (s.scope !== scope ? s : { ...s, allowed: on ? [...s.allowed, code] : s.allowed.filter((x) => x !== code) })),
  });
  const toggleGroup = (scope: string, g: SpecializationGroup, on: boolean) => setDraft({
    ...cur, scopes: cur.scopes.map((s) => (s.scope !== scope ? s : { ...s, allowed_groups: on ? [...s.allowed_groups, g] : s.allowed_groups.filter((x) => x !== g) })),
  });
  const addSpec = () => {
    const v = newSpec.trim();
    if (!v || cur.catalogue.some((c) => cur.specializations.includes(c.code) && [c.code, c.label_en, c.label_ar ?? '', ...(c.aliases ?? [])].some((x) => x && norm(x) === norm(v)))) return;
    const known = cur.catalogue.find((c) => [c.code, c.label_en, c.label_ar ?? '', ...(c.aliases ?? [])].some((x) => x && norm(x) === norm(v)));
    if (known) setDraft({ ...cur, specializations: [...cur.specializations, known.code] });   // an inactive code comes back
    else setDraft({ ...cur, specializations: [...cur.specializations, v], catalogue: [...cur.catalogue, { code: v, label_en: v, label_ar: null, group: null, groups: [], aliases: [], is_new: true }] });
    setNewSpec('');
  };
  const addScope = () => {
    const v = newScope.trim();
    if (!v || cur.scopes.some((s) => s.scope === v)) return;
    setDraft({ ...cur, scopes: [...cur.scopes, { scope: v, exempt: false, allowed: [], allowed_groups: [] }] }); setNewScope('');
  };
  const body: TeamScopeMatchInput = { specializations: cur.specializations, scopes: cur.scopes };

  return (
    <section className="card space-y-3 p-4" data-testid="page-team-scope">
      <h2 className="font-bold">{t('scopeMatch.title')}</h2>
      <p className="text-sm text-mute">{t('scopeMatch.note')}</p>
      {!editable && <p className="chip bg-card2 text-xs" data-testid="tsm-readonly">{t('scopeMatch.read_only')}</p>}
      <p className="mono text-xs text-mute" data-testid="tsm-version">{t('scopeMatch.version', { version: q.data?.version })}{draft && <span className="chip ms-2">{t('scopeMatch.unsaved')}</span>}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="tsm-grid">
          <thead className="text-mute">
            <tr>
              <th className="p-2 text-start">{t('scopeMatch.scope')}</th>
              <th className="p-2 text-center">{t('scopeMatch.exempt')}</th>
              {GROUPS.map((g) => <th key={g} className="p-2 text-center" data-testid={`tsm-group-col-${g}`}>{t('scopeMatch.group', { group: g })}</th>)}
              {cols.map((code) => (
                <th key={code} className="p-2 text-center" data-testid={`tsm-col-${code}`}>
                  <span className="inline-flex items-center gap-1">{label(code)}
                    {groupsOf(code).length > 0 && <span className="chip px-1 text-[10px]">{groupsOf(code).join(' + ')}</span>}
                    {editable && <button type="button" className="btn btn-ghost p-0.5" aria-label={t('scopeMatch.remove', { name: label(code) })} data-testid={`tsm-remove-col-${code}`}
                      onClick={() => setDraft({ ...cur, specializations: cur.specializations.filter((x) => x !== code), scopes: cur.scopes.map((s) => ({ ...s, allowed: s.allowed.filter((x) => x !== code) })) })}><X size={12} /></button>}
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
                    {editable && <button type="button" className="btn btn-ghost p-0.5" aria-label={t('scopeMatch.remove', { name: s.scope })} data-testid={`tsm-remove-row-${s.scope}`}
                      onClick={() => setDraft({ ...cur, scopes: cur.scopes.filter((x) => x.scope !== s.scope) })}><X size={12} /></button>}
                  </span>
                  {errs[`/scopes/${i}/scope`] && <p role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs[`/scopes/${i}/scope`]}`)}</p>}
                </td>
                <td className="p-2 text-center">
                  <input type="checkbox" data-testid={`tsm-exempt-${s.scope}`} aria-label={`${s.scope}: ${t('scopeMatch.exempt')}`} checked={s.exempt} disabled={!editable}
                    onChange={(e) => setDraft({ ...cur, scopes: cur.scopes.map((x) => (x.scope === s.scope ? { ...x, exempt: e.target.checked } : x)) })} />
                </td>
                {GROUPS.map((g) => (
                  <td key={g} className="p-2 text-center">
                    <input type="checkbox" data-testid={`tsm-group-${s.scope}-${g}`} disabled={!editable} aria-label={t('scopeMatch.group_cell', { group: g, scope: s.scope })}
                      checked={s.allowed_groups.includes(g)} onChange={(e) => toggleGroup(s.scope, g, e.target.checked)} />
                  </td>
                ))}
                {cols.map((code) => {
                  const viaGroupName = groupsOf(code).find((g) => s.allowed_groups.includes(g));
                  const viaGroup = !!viaGroupName;
                  return (
                    <td key={code} className="p-2 text-center">
                      <input type="checkbox" data-testid={`tsm-cell-${s.scope}-${code}`} disabled={!editable || viaGroup} aria-label={t('scopeMatch.cell', { specialization: label(code), scope: s.scope })}
                        title={viaGroup ? t('scopeMatch.via_group', { group: viaGroupName }) : undefined}
                        checked={viaGroup || s.allowed.includes(code)} onChange={(e) => toggle(s.scope, code, e.target.checked)} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {errs['/specializations'] && <p role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs['/specializations']}`)}</p>}
      {editable && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-semibold">{t('scopeMatch.new_specialization')}
              <input className="input mt-1 font-normal" data-testid="tsm-new-spec" maxLength={60} value={newSpec} onChange={(e) => setNewSpec(e.target.value)} /></label>
            <button type="button" className="btn" data-testid="tsm-add-spec" onClick={addSpec}><Plus size={14} />{t('scopeMatch.add_specialization')}</button>
            <label className="text-sm font-semibold">{t('scopeMatch.new_scope')}
              <input className="input mt-1 font-normal" data-testid="tsm-new-scope" maxLength={60} value={newScope} onChange={(e) => setNewScope(e.target.value)} /></label>
            <button type="button" className="btn" data-testid="tsm-add-scope" onClick={addScope}><Plus size={14} />{t('scopeMatch.add_scope')}</button>
          </div>
          <p className="text-xs text-mute">{t('scopeMatch.step_up_note')}</p>
          <button className="btn btn-accent" data-testid="tsm-save" disabled={!draft || !q.data} onClick={() => setOpen(true)}>{t('scopeMatch.save')}</button>
        </>
      )}
      {open && q.data && (
        <FormDialog open onClose={() => setOpen(false)} testid="tsm-dialog" title={t('scopeMatch.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: q.data.version, body: { ...body, reason } }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })} />
      )}
    </section>
  );
}
