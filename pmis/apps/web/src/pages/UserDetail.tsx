import { Building2, Copy, KeyRound, Lock, Pencil, RotateCcw, ShieldCheck, ShieldOff, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useCopyAssignments, useEditAssignments, useEndAssignments, useGroups, useMfa, useProfiles, useSetMfa, useUser } from '@/api/admin';
import { useMe } from '@/api/hooks';
import { useRegions } from '@/api/sites';
import type { Assignment, UserDetail, UserPickerItem } from '@/api/types';
import { AssignDialog, LEVELS } from '@/components/AssignDialog';
import { errText, FormDialog } from '@/components/FormDialog';
import { OrgDialog } from '@/components/OrgDialog';
import { PeoplePicker } from '@/components/PeoplePicker';
import { PersonTag } from '@/components/PersonTag';
import { MODULES, ScopePicker } from '@/components/ScopePicker';
import { useToast } from '@/components/Toast';
import { EnforceTwoFactorDialog, LocalBadges, ResetPasswordDialog, SystemAdminDialog, TwoFactorBadge, TwoFactorDialog } from '@/components/UserDialogs';
import { isAdmin } from '@/lib/perm';
import { fmtDateTime } from '@/lib/time';
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

/** Whether a one-time enrolment code is outstanding for a user who has not enrolled yet (contract 0.6.0). The code itself is never shown again. */
function EnrolCodeStatus({ expiresAt, locale }: { expiresAt: string | null; locale: string }) {
  const { t } = useTranslation();
  const [now] = useState(() => Date.now()); // when the card was opened: a code that ends meanwhile shows as expired after the next load
  if (!expiresAt) return <p className="mt-1 text-sm text-waitInk" data-testid="enrol-code-status" data-state="none">{t('twoFactor.admin_code_none')}</p>;
  const date = fmtDateTime(expiresAt, locale);
  return new Date(expiresAt).getTime() > now
    ? <p className="mt-1 text-sm text-mute" data-testid="enrol-code-status" data-state="active">{t('twoFactor.admin_code_active', { date })}</p>
    : <p className="mt-1 text-sm text-lateInk" data-testid="enrol-code-status" data-state="expired">{t('twoFactor.admin_code_expired', { date })}</p>;
}

/** Two-factor card (contract 0.5.0): state, and for an admin or a delegate holding users.two_factor: turn on, turn off, reset. Nobody changes their own. */
function TwoFactorAdminCard({ user, isSelf, canAdminister, onAction }: { user: UserDetail; isSelf: boolean; canAdminister: boolean; onAction: (a: 'on' | 'off' | 'reset' | 'code') => void }) {
  const { t, i18n } = useTranslation();
  const state = user.two_factor ?? 'off';
  const noLocal = !user.local_sign_in;
  const enforced = state !== 'off' && !!user.two_factor_enforced;
  const [enf, setEnf] = useState<null | boolean>(null);
  return (
    <section className="card p-4" data-testid="two-factor-admin-card">
      <h2 className="mb-1 flex items-center gap-2 font-bold">{state === 'off' ? <ShieldOff size={16} /> : <ShieldCheck size={16} />}{t('twoFactor.admin_title')}</h2>
      <p className="text-sm text-mute" data-testid="two-factor-admin-state">{t(`twoFactor.admin_state_${state}`)}</p>
      {state === 'pending_enrolment' && <EnrolCodeStatus expiresAt={user.two_factor_enrol_code_expires_at ?? null} locale={i18n.language} />}
      {state !== 'off' && <p className="mt-1 text-sm" data-testid="two-factor-enforced-state" data-enforced={enforced}>{t(enforced ? 'twoFactor.admin_enforced' : 'twoFactor.admin_not_enforced')}</p>}
      {noLocal && <p className="mt-1 text-sm text-mute">{t('twoFactor.admin_no_local')}</p>}
      {canAdminister && (
        <div className="mt-2 flex flex-wrap gap-2">
          {state === 'off'
            ? <button className="btn" data-testid="two-factor-on" disabled={isSelf || noLocal} title={isSelf ? t('twoFactor.admin_self') : undefined} onClick={() => onAction('on')}><ShieldCheck size={16} />{t('twoFactor.admin_turn_on')}</button>
            : <>
                {state === 'pending_enrolment' && <button className="btn" data-testid="two-factor-new-code" disabled={isSelf} title={isSelf ? t('twoFactor.admin_self') : undefined} onClick={() => onAction('code')}><KeyRound size={16} />{t('twoFactor.admin_new_code')}</button>}
                <button className="btn" data-testid="two-factor-off" disabled={isSelf} title={isSelf ? t('twoFactor.admin_self') : undefined} onClick={() => onAction('off')}><ShieldOff size={16} />{t('twoFactor.admin_turn_off')}</button>
                <button className="btn" data-testid="two-factor-reset" disabled={isSelf} title={isSelf ? t('twoFactor.admin_self') : undefined} onClick={() => onAction('reset')}><RotateCcw size={16} />{t('twoFactor.admin_reset')}</button>
                <button className="btn" data-testid="two-factor-enforce" disabled={isSelf} title={isSelf ? t('twoFactor.admin_self') : undefined} onClick={() => setEnf(!enforced)}><Lock size={16} />{t(enforced ? 'twoFactor.unenforce' : 'twoFactor.enforce')}</button>
              </>}
        </div>
      )}
      {isSelf && <p className="mt-1 text-sm text-lateInk" data-testid="two-factor-self-note">{t('twoFactor.admin_self')}</p>}
      {enf !== null && <EnforceTwoFactorDialog user={user} enforce={enf} onClose={() => setEnf(null)} />}
    </section>
  );
}

export function UserDetailPage() {
  const { t, i18n } = useTranslation();
  const { userId = '' } = useParams();
  const toast = useToast();
  const me = useMe(true), q = useUser(userId), regions = useRegions(), profiles = useProfiles(), groups = useGroups();
  const end = useEndAssignments(userId);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<null | 'assign' | 'edit' | 'end' | 'copy' | 'reset' | 'admin' | 'unadmin' | 'org' | 'tf_on' | 'tf_off' | 'tf_reset' | 'tf_code'>(null);
  const ar = i18n.language === 'ar';
  if (q.isError) return <p role="alert" data-testid="user-missing">{t('errors.generic')}</p>;
  const u = q.data;
  if (!u) return <p>{t('common.loading')}</p>;
  const isSysAdmin = (u.groups ?? []).some((g) => g.is_system_admins);
  const adminGroupId = groups.data?.find((g) => g.is_system_admins)?.id;
  const canEditOrg = isAdmin(me.data) || !!me.data?.effective.grants.some((g) => (g.action as string) === 'edit' && ['users', 'admin.users'].includes(g.module_key as string));
  const canTwoFactor = isAdmin(me.data) || !!me.data?.effective.grants.some((g) => (g.action as string) === 'administer' && g.module_key === 'users');
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
        <TwoFactorBadge user={u} />
        <MfaBadge user={u} />
        <span className="text-mute" dir="ltr">{u.email}</span>
        {isSysAdmin && <span className="chip bg-openBg text-openInk" data-testid="sysadmin-badge">{t('sysAdmin.badge')}</span>}
        <div className="ms-auto flex flex-wrap gap-2">
        {isAdmin(me.data) && adminGroupId && (
          <button className="btn" data-testid={isSysAdmin ? 'sysadmin-remove' : 'sysadmin-make'} disabled={u.id === me.data?.user.id}
            title={u.id === me.data?.user.id ? t('sysAdmin.self') : undefined} onClick={() => setDlg(isSysAdmin ? 'unadmin' : 'admin')}>
            <ShieldCheck size={16} />{t(isSysAdmin ? 'sysAdmin.remove' : 'sysAdmin.make')}</button>
        )}
        {isAdmin(me.data) && (
          <button className="btn" data-testid="user-reset-password" disabled={u.id === me.data?.user.id} title={u.id === me.data?.user.id ? t('resetPw.self') : undefined} onClick={() => setDlg('reset')}><KeyRound size={16} />{t('resetPw.open')}</button>
        )}
        </div>
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
      <section className="card p-4" data-testid="org-card">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="me-auto flex items-center gap-2 font-bold"><Building2 size={16} />{t('org.title')}</h2>
          {canEditOrg && <button className="btn" data-testid="org-edit" onClick={() => setDlg('org')}><Pencil size={16} />{t('org.edit')}</button>}
        </div>
        <dl className="grid gap-2 text-sm md:grid-cols-2">
          <div><dt className="text-mute">{t('org.manager')}</dt><dd data-testid="org-manager-value">{u.manager ? <PersonTag name={u.manager.display_name} employeeId={u.manager.employee_id} /> : <span className="text-mute">{t('org.none')}</span>}</dd></div>
          <div><dt className="text-mute">{t('org.department')}</dt><dd data-testid="org-department-value">{u.department ? (ar && u.department.name_ar) || u.department.name_en : <span className="text-mute">{t('org.none')}</span>}</dd></div>
        </dl>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <MfaCard userId={userId} isSelf={u.id === me.data?.user.id} />
        <TwoFactorAdminCard user={u} isSelf={u.id === me.data?.user.id} canAdminister={canTwoFactor} onAction={(a) => setDlg(`tf_${a}`)} />
        <section className="card p-4"><h2 className="mb-1 font-bold">{t('users.groups')}</h2>
          {(u.groups ?? []).length ? <ul className="list-disc ps-5 text-sm">{u.groups!.map((g) => <li key={g.id}>{g.name}</li>)}</ul> : <p className="text-sm text-mute">—</p>}</section>
      </div>
      {dlg === 'assign' && <AssignDialog open onClose={() => setDlg(null)} initialMode="person" initialPeople={[{ id: u.id, display_name: u.display_name, employee_id: u.employee_id ?? '' }]} />}
      {dlg === 'edit' && <EditDialog userId={userId} rows={chosen} onClose={() => { setDlg(null); setSel(new Set()); }} />}
      {dlg === 'org' && <OrgDialog user={u} onClose={() => setDlg(null)} />}
      {dlg === 'reset' && <ResetPasswordDialog user={u} onClose={() => setDlg(null)} />}
      {(dlg === 'tf_on' || dlg === 'tf_off' || dlg === 'tf_reset' || dlg === 'tf_code') && <TwoFactorDialog user={u} action={dlg === 'tf_on' ? 'on' : dlg === 'tf_off' ? 'off' : dlg === 'tf_reset' ? 'reset' : 'code'} onClose={() => setDlg(null)} />}
      {(dlg === 'admin' || dlg === 'unadmin') && adminGroupId && <SystemAdminDialog user={u} adminGroupId={adminGroupId} remove={dlg === 'unadmin'} onClose={() => setDlg(null)} />}
      {dlg === 'copy' && <CopyDialog fromId={userId} onClose={() => setDlg(null)} />}
      {dlg === 'end' && (
        <FormDialog open onClose={() => setDlg(null)} testid="end-dialog" title={t('users.end_title', { count: chosen.length })} busy={end.isPending} error={end.isError ? errText(end.error, t) : null}
          onSubmit={(reason) => end.mutate({ rows: chosen, reason }, { onSuccess: () => { toast(t('users.ended')); setDlg(null); setSel(new Set()); } })} />
      )}
    </div>
  );
}
