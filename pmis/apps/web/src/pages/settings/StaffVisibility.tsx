import { X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGroups, useRoles } from '@/api/admin';
import { useHideStaffFields, useSetStaffVisibility, useStaffVisibility } from '@/api/settings';
import type { MatrixAssigneeT, StaffFieldVisibility, StaffVisibility as SV, UserPickerItem } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { PeoplePicker } from '@/components/PeoplePicker';
import { useToast } from '@/components/Toast';

type F = 'email' | 'phone';

function Assignees({ id, list, onChange }: { id: string; list: MatrixAssigneeT[]; onChange: (l: MatrixAssigneeT[]) => void }) {
  const { t } = useTranslation();
  const roles = useRoles(), groups = useGroups();
  const [kind, setKind] = useState<'role' | 'group' | 'user'>('role');
  const [people, setPeople] = useState<UserPickerItem[]>([]);
  const add = (a: MatrixAssigneeT) => !list.some((x) => x.ref_id === a.ref_id) && onChange([...list, a]);
  return (
    <div className="space-y-1" data-testid={id}>
      <div className="flex flex-wrap gap-1">{list.map((a) => <span key={a.ref_id} className="chip gap-1 bg-openBg text-openInk" data-testid={`${id}-chip-${a.label}`}>{t(`holder.${a.kind}`)}: {a.label}<button type="button" aria-label={t('common.remove')} onClick={() => onChange(list.filter((x) => x.ref_id !== a.ref_id))}><X size={12} /></button></span>)}</div>
      <div className="flex gap-1">
        <select className="input w-auto" aria-label={t('sv.kind')} data-testid={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{(['role', 'group', 'user'] as const).map((k) => <option key={k} value={k}>{t(`holder.${k}`)}</option>)}</select>
        {kind === 'role' && <select className="input" aria-label={t('holder.role')} data-testid={`${id}-role`} value="" onChange={(e) => { const r = roles.data?.find((x) => x.id === e.target.value); if (r) add({ kind: 'role', ref_id: r.id, label: r.name_en }); }}><option value="">—</option>{(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name_en}</option>)}</select>}
        {kind === 'group' && <select className="input" aria-label={t('holder.group')} data-testid={`${id}-group`} value="" onChange={(e) => { const g = groups.data?.find((x) => x.id === e.target.value); if (g) add({ kind: 'group', ref_id: g.id, label: g.name }); }}><option value="">—</option>{(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}
      </div>
      {kind === 'user' && <PeoplePicker id={`${id}-people`} single value={people} onChange={(v) => { setPeople([]); if (v[0]) add({ kind: 'user', ref_id: v[0].id, label: v[0].display_name, employee_id: v[0].employee_id, user_id: v[0].id }); }} />}
    </div>
  );
}

export function StaffVisibility() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useStaffVisibility(), save = useSetStaffVisibility(), hide = useHideStaffFields();
  const [draft, setDraft] = useState<SV['fields'] | null>(null);
  const [open, setOpen] = useState(false);
  const [emp, setEmp] = useState(''), [hidden, setHidden] = useState<F[]>([]), [hOpen, setHOpen] = useState(false);
  if (!q.data) return <p>{t('common.loading')}</p>;
  const d = draft ?? q.data.fields;
  const patch = (f: F, v: Partial<StaffFieldVisibility>) => setDraft({ ...d, [f]: { ...d[f], ...v } });
  return (
    <div className="space-y-4" data-testid="page-staff-visibility">
      <p className="text-sm text-mute">{t('sv.note')}</p>
      {(['email', 'phone'] as const).map((f) => (
        <section key={f} className="card space-y-2 p-4" data-testid={`sv-${f}`}>
          <h2 className="font-bold">{t(`card.${f}`)}</h2>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid={`sv-${f}-default`} checked={d[f].default_visible} onChange={(e) => patch(f, { default_visible: e.target.checked })} />{t('sv.default_visible')}</label>
          {!d[f].default_visible && <div><b className="text-sm">{t('sv.allow')}</b><Assignees id={`sv-${f}-allow`} list={d[f].allow} onChange={(allow) => patch(f, { allow })} /></div>}
          <div><b className="text-sm">{t('sv.deny')}</b><Assignees id={`sv-${f}-deny`} list={d[f].deny} onChange={(deny) => patch(f, { deny })} /><p className="text-xs text-mute">{t('sv.deny_wins')}</p></div>
        </section>))}
      <button className="btn btn-accent" data-testid="sv-save" disabled={!draft} onClick={() => setOpen(true)}>{t('common.save')}</button>
      <section className="card space-y-2 p-4" data-testid="sv-hide">
        <h2 className="font-bold">{t('sv.hide_one')}</h2>
        <label className="block max-w-48 text-sm font-semibold">{t('sv.employee_id')}<input className="input mono mt-1 font-normal" inputMode="numeric" maxLength={4} data-testid="sv-hide-emp" value={emp} onChange={(e) => setEmp(e.target.value)} /></label>
        <div className="flex gap-3 text-sm">{(['email', 'phone'] as const).map((f) => <label key={f} className="flex items-center gap-1"><input type="checkbox" data-testid={`sv-hide-${f}`} checked={hidden.includes(f)} onChange={(e) => setHidden(e.target.checked ? [...hidden, f] : hidden.filter((x) => x !== f))} />{t(`card.${f}`)}</label>)}</div>
        <button className="btn" data-testid="sv-hide-save" disabled={!/^\d{4}$/.test(emp)} onClick={() => setHOpen(true)}>{t('common.save')}</button>
      </section>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="sv-dialog" title={t('sv.title')} busy={save.isPending} error={save.isError ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ version: q.data.version, fields: d, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })} />
      )}
      {hOpen && (
        <FormDialog open onClose={() => setHOpen(false)} testid="sv-hide-dialog" title={t('sv.hide_one')} busy={hide.isPending} error={hide.isError ? errText(hide.error, t) : null}
          onSubmit={(reason) => hide.mutate({ employee_id: emp, hidden_fields: hidden, reason }, { onSuccess: () => { toast(t('settings.audited')); setHOpen(false); } })} />
      )}
    </div>
  );
}
