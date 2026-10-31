import { Plus, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCatalogue, useCreateDelegation, useDelegations, useGroups, useRevokeDelegation, useRoles } from '@/api/admin';
import { useMe } from '@/api/hooks';
import { useRegions } from '@/api/sites';
import type { DelegableRight, UserPickerItem } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { PeoplePicker } from '@/components/PeoplePicker';
import { PersonTag } from '@/components/PersonTag';
import { ScopePicker } from '@/components/ScopePicker';
import { useToast } from '@/components/Toast';

export const RIGHTS: DelegableRight[] = ['unlock', 'skip', 'mark_na', 'accept_without_document', 'accept_without_workflow', 'reopen', 'edit_date', 'reassign', 'users.edit', 'assignments.edit', 'groups.edit', 'matrix.edit', 'roles.edit', 'profiles.edit', 'settings.edit', 'documents.edit', 'templates.edit', 'fields.edit', 'workflow.edit', 'workflow.publish', 'workflow.migrate', 'warehouse.items.edit'];
const TONE: Record<string, string> = { active: 'bg-doneBg text-doneInk', scheduled: 'bg-openBg text-openInk', expired: 'bg-lockBg text-lockInk', revoked: 'bg-lateBg text-lateInk' };
const STATES = ['active', 'scheduled', 'expired', 'revoked', 'all'];

function GrantDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true);
  const create = useCreateDelegation();
  const { i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const regions = useRegions(), roles = useRoles(), groups = useGroups(), catalogue = useCatalogue();
  const rights_all = catalogue.data?.delegable_rights ?? RIGHTS;
  const [kind, setKind] = useState<'user' | 'role' | 'group'>('user');
  const [targetId, setTargetId] = useState('');
  const [reg, setReg] = useState<'all' | number[]>('all');
  const [redeleg, setRedeleg] = useState(false);
  const [to, setTo] = useState<UserPickerItem[]>([]);
  const [scope, setScope] = useState<'full' | 'partial'>('partial');
  const [rights, setRights] = useState<DelegableRight[]>([]);
  const [from, setFrom] = useState('2026-10-25');
  const [until, setUntil] = useState('');
  const self = kind === 'user' && to[0]?.id === me.data?.user.id;
  const bad = (kind === 'user' ? !to.length : !targetId) || self || (reg !== 'all' && !reg.length) || (scope === 'partial' && !rights.length) || !from || (!!until && until < from);
  return (
    <FormDialog open onClose={onClose} wide testid="delegation-dialog" title={t('deleg.grant')} disabled={bad} busy={create.isPending} error={create.isError ? errText(create.error, t) : null}
      onSubmit={(reason) => create.mutate({ target_kind: kind, target_id: kind === 'user' ? to[0].id : targetId, region_codes: reg === 'all' ? [] : reg, module_codes: [], allow_redelegate: redeleg, scope, ...(scope === 'partial' ? { rights } : {}), valid_from: `${from}T00:00:00Z`, valid_to: until ? `${until}T23:59:59Z` : null, reason }, { onSuccess: () => { toast(t('deleg.saved')); onClose(); } })}>
      <div className="flex gap-3 text-sm" data-testid="deleg-kind">
        {(['user', 'role', 'group'] as const).map((k) => <label key={k} className="flex items-center gap-1"><input type="radio" name="deleg-kind" data-testid={`deleg-kind-${k}`} checked={kind === k} onChange={() => { setKind(k); setTargetId(''); }} />{t(`deleg.kind_${k}`)}</label>)}
      </div>
      <div><b className="text-sm">{t('deleg.to')}</b>
        {kind === 'user' ? <PeoplePicker id="deleg-to" single value={to} onChange={setTo} blockId={me.data?.user.id} blockHint={t('deleg.self_blocked')} />
          : <select className="input mt-1" data-testid="deleg-target" aria-label={t('deleg.to')} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">—</option>
            {kind === 'role' ? (roles.data ?? []).filter((r) => r.is_active).map((r) => <option key={r.id} value={r.id}>{(ar && r.name_ar) || r.name_en}</option>) : (groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>}</div>
      <div className="flex gap-3 text-sm">
        {(['partial', 'full'] as const).map((s) => <label key={s} className="flex items-center gap-1"><input type="radio" name="deleg-scope" data-testid={`deleg-scope-${s}`} checked={scope === s} onChange={() => setScope(s)} />{t(`deleg.scope_${s}`)}</label>)}
      </div>
      {scope === 'partial' && (
        <fieldset data-testid="deleg-rights"><legend className="text-sm font-semibold">{t('deleg.rights')}</legend>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">{rights_all.map((r) => (
            <label key={r} className="flex items-center gap-1"><input type="checkbox" data-testid={`deleg-right-${r}`} checked={rights.includes(r)} onChange={(e) => setRights(e.target.checked ? [...rights, r] : rights.filter((x) => x !== r))} />{t(`right.${r}`)}</label>))}</div></fieldset>
      )}
      <ScopePicker id="deleg-regions" label={t('assign.regions')} options={(regions.data ?? []).map((r): [number, string] => [r.id, (ar && r.name_ar) || r.name_en])} value={reg} onChange={setReg} />
      <p className="text-xs text-mute" data-testid="deleg-modules-note">{t('deleg.modules_unsupported')}</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="deleg-redelegate" checked={redeleg} onChange={(e) => setRedeleg(e.target.checked)} />{t('deleg.allow_redelegate')}</label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm font-semibold">{t('deleg.from')}<input type="date" className="input mt-1 font-normal" data-testid="deleg-from" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm font-semibold">{t('deleg.until')}<input type="date" className="input mt-1 font-normal" data-testid="deleg-until" value={until} onChange={(e) => setUntil(e.target.value)} /><span className="text-xs font-normal text-mute">{t('deleg.until_hint')}</span></label>
      </div>
    </FormDialog>
  );
}

const key = (d: { to_user?: { employee_id?: string | null } | null; target?: { id: string } }) => d.to_user?.employee_id ?? d.target?.id ?? '';

export function Delegation() {
  const { t } = useTranslation();
  const toast = useToast();
  const [state, setState] = useState('active');
  const list = useDelegations(state), revoke = useRevokeDelegation();
  const [dlg, setDlg] = useState<null | 'grant' | string>(null);
  return (
    <div data-testid="page-delegation">
      <div className="mb-4 flex items-center gap-3">
        <div className="me-auto"><h2 className="text-lg font-bold">{t('deleg.title')}</h2><p className="text-mute">{t('deleg.subtitle')}</p></div>
        <button className="btn btn-accent" data-testid="deleg-new" onClick={() => setDlg('grant')}><Plus size={16} />{t('deleg.grant')}</button>
      </div>
      <div role="tablist" className="mb-3 flex flex-wrap gap-1">
        {STATES.map((s) => <button key={s} role="tab" aria-selected={state === s} data-testid={`deleg-tab-${s}`} className={`btn ${state === s ? 'btn-accent' : ''}`} onClick={() => setState(s)}>{t(`deleg.state_${s}`)}</button>)}
      </div>
      <div className="card overflow-x-auto"><table className="w-full text-sm">
        <thead className="border-b border-line bg-card2 text-mute"><tr><th className="p-2 text-start">{t('deleg.to')}</th><th className="p-2 text-start">{t('deleg.scope')}</th><th className="p-2 text-start">{t('deleg.validity')}</th><th className="p-2 text-start">{t('users.status')}</th><th className="p-2 text-start">{t('common.reason')}</th><th className="p-2" /></tr></thead>
        <tbody data-testid="deleg-list">
          {(list.data ?? []).map((d) => (
            <tr key={d.id} className="border-b border-line" data-testid={`deleg-row-${key(d)}`}>
              <td className="p-2">{d.to_user ? <PersonTag name={d.to_user.display_name} employeeId={d.to_user.employee_id} /> : <span className="chip bg-card2">{t(`deleg.kind_${d.target_kind}`)}: {d.target?.label}</span>}</td>
              <td className="p-2">{d.scope === 'full' ? t('deleg.scope_full') : (d.rights ?? []).map((r) => t(`right.${r}`)).join(', ')}
                <div className="text-xs text-mute" data-testid={`deleg-scope-${key(d)}`}>{d.region_codes?.length ? t('deleg.n_regions', { count: d.region_codes.length }) : t('deleg.all_regions')}{d.allow_redelegate ? ` · ${t('deleg.redelegate_on')}` : ''}</div></td>
              <td className="mono p-2 text-xs">{d.valid_from.slice(0, 10)} → {d.valid_to ? d.valid_to.slice(0, 10) : t('assign.open_ended')}</td>
              <td className="p-2"><span className={`chip ${TONE[d.state]}`}>{t(`deleg.state_${d.state}`)}</span></td>
              <td className="p-2 text-mute">{d.reason}</td>
              <td className="p-2 text-end">{(d.state === 'active' || d.state === 'scheduled') && <button className="btn" data-testid={`deleg-revoke-${key(d)}`} onClick={() => setDlg(d.id)}><Undo2 size={14} />{t('deleg.revoke')}</button>}</td>
            </tr>
          ))}
          {list.isSuccess && !(list.data ?? []).length && <tr><td colSpan={6} className="p-6 text-center text-mute" data-testid="deleg-empty">{t('deleg.empty')}</td></tr>}
        </tbody>
      </table></div>
      {dlg === 'grant' && <GrantDialog onClose={() => setDlg(null)} />}
      {dlg && dlg !== 'grant' && (
        <FormDialog open onClose={() => setDlg(null)} testid="revoke-dialog" title={t('deleg.revoke')} busy={revoke.isPending} error={revoke.isError ? errText(revoke.error, t) : null}
          onSubmit={(reason) => { revoke.mutate({ id: dlg, reason }, { onSuccess: () => toast(t('deleg.revoked')), onError: (e) => toast(errText(e, t), 'err') }); setDlg(null); }} />
      )}
    </div>
  );
}
