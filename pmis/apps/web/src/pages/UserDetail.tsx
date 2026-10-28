import { Copy, KeyRound, Pencil, ShieldCheck, ShieldOff, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useCopyAssignments, useEditAssignments, useEndAssignments, useMfa, useProfiles, useSetMfa, useUser } from '@/api/admin';
import { useMe } from '@/api/hooks';
import { useRegions } from '@/api/sites';
import type { Assignment, UserPickerItem } from '@/api/types';
import { AssignDialog, LEVELS } from '@/components/AssignDialog';
import { errText, FormDialog } from '@/components/FormDialog';
import { PeoplePicker } from '@/components/PeoplePicker';
import { MODULES, ScopePicker } from '@/components/ScopePicker';
import { useToast } from '@/components/Toast';
import { LocalBadges, ResetPasswordDialog } from '@/components/UserDialogs';
import { isAdmin } from '@/lib/perm';
import { MfaBadge, STATUS_TONE } from './Users';

function EditDialog({ userId, rows, onClose }: { userId: string; rows: Assignment[]; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const regions = useRegions();
  const edit = useEditAssignments(userId);
  const first = rows[0];
  const [level, setLevel] = useState(rows.length === 1 ? first.permission_level : '');
  const [reg, setReg] = useState<'all' | number[]>(rows.length === 1 ? (first.region_ids as 'all' | number[]) : 'all');
  const [mods, setMods] = useState<'all' | string[]>(rows.length === 1 ? (first.module_keys as 'all' | string[]) : 'all');
  const [to, setTo] = useState(rows.length === 1 ? (first.valid_to ?? '').slice(0, 10) : '');
  const ar = i18n.language === 'ar';
  const bad = (reg !== 'all' && !reg.length) || (mods !== 'all' && !mods.length);
  return (
    <FormDialog open onClose={onClose} testid="edit-assignment" title={t('assign.edit_title', { count: rows.length })} busy={edit.isPending} disabled={bad} error={edit.isError ? errText(edit.error, t) : null}
      onSubmit={(reason) => edit.mutate({ rows, reason, patch: { ...(level ? { permission_level: level as Assignment['permission_level'] } : {}), region_ids: reg, module_keys: mods, ...(to ? { valid_to: `${to}T23:59:59Z` } : {}) } }, { onSuccess: onClose })}>
      <label className="block text-sm font-semibold">{t('assign.level')}
        <select className="input mt-1 font-normal" data-testid="edit-level" value={level} onChange={(e) => setLevel(e.target.value)}>
          {rows.length > 1 && <option value="">—</option>}{LEVELS.map((l) => <option key={l} value={l}>{t(`level_name.${l}`)}</option>)}
        </select></label>
      <ScopePicker id="edit-regions" label={t('assign.regions')} options={(regions.data ?? []).map((r): [number, string] => [r.id, (ar && r.name_ar) || r.name_en])} value={reg} onChange={setReg} />
      <ScopePicker id="edit-modules" label={t('assign.modules')} options={MODULES.map((m): [string, string] => [m, t(`module.${m}`)])} value={mods} onChange={setMods} />
      <label className="block text-sm font-semibold">{t('assign.valid_to')}<input type="date" className="input mt-1 font-normal" data-testid="edit-valid-to" value={to} onChange={(e) => setTo(e.target.value)} /></label>
    </FormDialog>
  );
}

function CopyDialog({ fromId, onClose }: { fromId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const copy = useCopyAssignments();
  const [people, setPeople] = useState<UserPickerItem[]>([]);
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  return (
    <FormDialog open onClose={onClose} testid="copy-dialog" title={t('assign.copy_title')} busy={copy.isPending} disabled={!people.length} error={copy.isError ? errText(copy.error, t) : null}
      onSubmit={(reason) => copy.mutate({ from_user_id: fromId, to_user_ids: people.map((p) => p.id), mode, reason, dry_run: false }, { onSuccess: (r) => { toast(t('assign.result', { done: r.done.length, skipped: r.skipped.length })); onClose(); } })}>
      <PeoplePicker id="copy-people" value={people} onChange={setPeople} />
      <label className="block text-sm font-semibold">{t('assign.copy_mode')}
        <select className="input mt-1 font-normal" data-testid="copy-mode" value={mode} onChange={(e) => setMode(e.target.value as 'add' | 'replace')}><option value="add">{t('assign.mode_add')}</option><option value="replace">{t('assign.mode_replace')}</option></select></label>
    </FormDialog>
  );
}

function MfaCard({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useMfa(userId), set = useSetMfa(userId);
  const [open, setOpen] = useState<null | 'set' | 'revoke'>(null);
  const [until, setUntil] = useState('');
  const m = q.data;
  return (
    <section className="card p-4" data-testid="mfa-card">
      <h2 className="mb-1 flex items-center gap-2 font-bold">{m?.exempt ? <ShieldOff size={16} /> : <ShieldCheck size={16} />}{t('mfa.title')}</h2>
      <p className="text-sm text-mute" data-testid="mfa-state">{m?.exempt ? (m.until ? t('mfa.exempt_until', { date: m.until.slice(0, 10) }) : t('mfa.exempt_revoked')) : t('mfa.required')}</p>
      {m?.exempt && m.reason && <p className="text-sm">{t('mfa.reason_is', { reason: m.reason })}</p>}
      <p className="mt-1 text-xs text-mute">{t('mfa.scope_note')}</p>
      <div className="mt-2 flex gap-2">
        <button className="btn" data-testid="mfa-set" disabled={isSelf || set.isPending} onClick={() => setOpen('set')}>{m?.exempt ? t('mfa.change') : t('mfa.exempt')}</button>
        {m?.exempt && <button className="btn" data-testid="mfa-revoke" disabled={isSelf || set.isPending} onClick={() => setOpen('revoke')}>{t('mfa.revoke')}</button>}
      </div>
      {isSelf && <p className="mt-1 text-sm text-lateInk" data-testid="mfa-self-note">{t('mfa.self_note')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(null)} testid="mfa-dialog" title={open === 'set' ? t('mfa.exempt') : t('mfa.revoke')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate(open === 'set' ? { reason, until: until ? `${until}T23:59:59Z` : null } : { reason, revoke: true }, { onSuccess: () => { toast(t('mfa.saved')); setOpen(null); } })}>
          {open === 'set' && <label className="block text-sm font-semibold">{t('mfa.until_label')}<input type="date" className="input mt-1 font-normal" data-testid="mfa-until" value={until} onChange={(e) => setUntil(e.target.value)} /><span className="text-xs font-normal text-mute">{t('mfa.until_hint')}</span></label>}
        </FormDialog>
      )}
    </section>
  );
}

export function UserDetailPage() {
  const { t, i18n } = useTranslation();
  const { userId = '' } = useParams();
  const toast = useToast();
  const me = useMe(true), q = useUser(userId), regions = useRegions(), profiles = useProfiles();
  const end = useEndAssignments(userId);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<null | 'assign' | 'edit' | 'end' | 'copy' | 'reset'>(null);
  const ar = i18n.language === 'ar';
  if (q.isError) return <p role="alert" data-testid="user-missing">{t('errors.generic')}</p>;
  const u = q.data;
  if (!u) return <p>{t('common.loading')}</p>;
  const rows = (u.assignments ?? []).filter((a) => a.is_active_now !== false);
  const chosen = rows.filter((a) => sel.has(a.id));
  const rn = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (ar && r?.name_ar) || r?.name_en || String(id); };
  const scope = (v: 'all' | string[] | number[] | undefined, f: (x: never) => string) => (v === 'all' || v === undefined ? t('common.all') : (v as never[]).map(f).join(', '));
  const pname = (id: string) => { const p = profiles.data?.find((x) => x.id === id); return p ? (ar && p.name_ar) || p.name_en : id.slice(0, 4); };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div data-testid="page-user-detail" className="space-y-4">
      <Link to="/admin/users" className="text-sm text-mute">{t('users.back')}</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold" data-testid="user-name">{u.display_name}</h1>
        {u.employee_id && <span className="mono rounded bg-card2 px-1 text-sm">{u.employee_id}</span>}
        <span className={`chip ${STATUS_TONE[u.status]}`} data-testid="user-status">{t(`userStatus.${u.status}`)}</span>
        <LocalBadges user={u} />
        <MfaBadge user={u} />
        <span className="text-mute" dir="ltr">{u.email}</span>
        {isAdmin(me.data) && (
          <button className="btn ms-auto" data-testid="user-reset-password" disabled={u.id === me.data?.user.id} title={u.id === me.data?.user.id ? t('resetPw.self') : undefined} onClick={() => setDlg('reset')}><KeyRound size={16} />{t('resetPw.open')}</button>
        )}
      </div>
      <section className="card p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="me-auto font-bold">{t('users.assignments')}</h2>
          <button className="btn btn-accent" data-testid="detail-assign" onClick={() => setDlg('assign')}><UserPlus size={16} />{t('users.assign_role')}</button>
          <button className="btn" data-testid="detail-edit" disabled={!chosen.length} onClick={() => setDlg('edit')}><Pencil size={16} />{t('users.edit_selected')}</button>
          <button className="btn" data-testid="detail-end" disabled={!chosen.length} onClick={() => setDlg('end')}><UserMinus size={16} />{t('users.end_selected')}</button>
          <button className="btn" data-testid="detail-copy" disabled={!rows.length} onClick={() => setDlg('copy')}><Copy size={16} />{t('users.copy')}</button>
        </div>
        {u.status === 'pending_assignment' && <p className="mb-2 rounded-md bg-waitBg p-2 text-sm text-waitInk" data-testid="user-pending-note">{t('users.pending_note')}</p>}
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-mute"><tr><th className="w-8" /><th className="p-2 text-start">{t('users.role')}</th><th className="p-2 text-start">{t('assign.level')}</th><th className="p-2 text-start">{t('assign.team')}</th><th className="p-2 text-start">{t('assign.regions')}</th><th className="p-2 text-start">{t('assign.modules')}</th><th className="p-2 text-start">{t('assign.validity')}</th><th className="p-2 text-start">{t('assign.profile')}</th></tr></thead>
          <tbody data-testid="assignment-list">
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-line" data-testid={`assignment-${a.role.code}`}>
                <td className="p-2"><input type="checkbox" aria-label={a.role.name_en} data-testid={`assignment-select-${a.role.code}`} checked={sel.has(a.id)} onChange={() => toggle(a.id)} /></td>
                <td className="p-2 font-semibold">{(ar && a.role.name_ar) || a.role.name_en}</td>
                <td className="p-2"><span className="chip bg-openBg text-openInk" data-testid={`assignment-level-${a.role.code}`}>{t(`level_name.${a.permission_level}`)}</span></td>
                <td className="p-2">{t(`team.${a.team ?? 'none'}`)}</td>
                <td className="p-2">{scope(a.region_ids, rn as never)}</td>
                <td className="p-2">{scope(a.module_keys, ((m: string) => t(`module.${m}`, m)) as never)}</td>
                <td className="p-2 mono text-xs">{a.valid_from.slice(0, 10)} → {a.valid_to ? a.valid_to.slice(0, 10) : t('assign.open_ended')}</td>
                <td className="p-2">{a.profile_ids.length ? a.profile_ids.map(pname).join(', ') : '—'}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="p-4 text-center text-mute" data-testid="assignments-empty">{t('users.no_assignments')}</td></tr>}
          </tbody>
        </table></div>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <MfaCard userId={userId} isSelf={u.id === me.data?.user.id} />
        <section className="card p-4"><h2 className="mb-1 font-bold">{t('users.groups')}</h2>
          {(u.groups ?? []).length ? <ul className="list-disc ps-5 text-sm">{u.groups!.map((g) => <li key={g.id}>{g.name}</li>)}</ul> : <p className="text-sm text-mute">—</p>}</section>
      </div>
      {dlg === 'assign' && <AssignDialog open onClose={() => setDlg(null)} initialMode="person" initialPeople={[{ id: u.id, display_name: u.display_name, employee_id: u.employee_id ?? '' }]} />}
      {dlg === 'edit' && <EditDialog userId={userId} rows={chosen} onClose={() => { setDlg(null); setSel(new Set()); }} />}
      {dlg === 'reset' && <ResetPasswordDialog user={u} onClose={() => setDlg(null)} />}
      {dlg === 'copy' && <CopyDialog fromId={userId} onClose={() => setDlg(null)} />}
      {dlg === 'end' && (
        <FormDialog open onClose={() => setDlg(null)} testid="end-dialog" title={t('users.end_title', { count: chosen.length })} busy={end.isPending} error={end.isError ? errText(end.error, t) : null}
          onSubmit={(reason) => end.mutate({ rows: chosen, reason }, { onSuccess: () => { toast(t('users.ended')); setDlg(null); setSel(new Set()); } })} />
      )}
    </div>
  );
}
