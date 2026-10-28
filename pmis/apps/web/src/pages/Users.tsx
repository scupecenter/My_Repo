import { RotateCcw, ShieldOff, Trash2, UserPlus, UserRoundPlus, UserX } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useRoles, useUsers } from '@/api/admin';
import { useMe } from '@/api/hooks';
import { useDeactivateUser, useDeletedUsers, useDeleteUser, useRestoreUser } from '@/api/settings';
import type { DeletedUser, User } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { AssignDialog } from '@/components/AssignDialog';
import { CreateUserDialog, LocalBadges } from '@/components/UserDialogs';
import { isAdmin } from '@/lib/perm';
import { IdBadge } from '@/components/PersonTag';

export const STATUS_TONE: Record<string, string> = { active: 'bg-doneBg text-doneInk', pending_assignment: 'bg-waitBg text-waitInk', suspended: 'bg-lateBg text-lateInk', disabled: 'bg-lockBg text-lockInk' };

export function MfaBadge({ user }: { user: Pick<User, 'mfa_exempt' | 'employee_id' | 'mfa_exempt_until'> }) {
  const { t } = useTranslation();
  if (!user.mfa_exempt) return null;
  return <span className="chip gap-1 bg-waitBg text-waitInk" data-testid={`mfa-badge-${user.employee_id}`} title={user.mfa_exempt_until ? t('mfa.until', { date: user.mfa_exempt_until.slice(0, 10) }) : t('mfa.until_revoked')}><ShieldOff size={12} />{t('mfa.badge')}</span>;
}

type Act = { kind: 'deactivate' | 'reactivate' | 'delete'; user: User } | { kind: 'restore'; deleted: DeletedUser };

function ActDialog({ act, onClose }: { act: Act; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const status = useDeactivateUser(), del = useDeleteUser(), restore = useRestoreUser();
  const m = act.kind === 'delete' ? del : act.kind === 'restore' ? restore : status;
  const done = (k: string) => ({ onSuccess: () => { toast(t(`users.done_${k}`)); onClose(); } });
  return (
    <FormDialog open onClose={onClose} testid="user-act-dialog" title={t(`users.${act.kind}_title`, { name: act.kind === 'restore' ? act.deleted.display_name : act.user.display_name })} busy={m.isPending} error={m.isError ? errText(m.error, t) : null}
      submitLabel={t(`users.${act.kind}`)}
      onSubmit={(reason) => {
        if (act.kind === 'delete') del.mutate({ user: act.user, reason }, done('delete'));
        else if (act.kind === 'restore') restore.mutate({ user: act.deleted, reason }, done('restore'));
        else status.mutate({ user: act.user, status: act.kind === 'deactivate' ? 'disabled' : 'active', reason }, done(act.kind));
      }}>
      {act.kind !== 'restore' && act.kind !== 'reactivate' && <p className="rounded-md bg-card2 p-2 text-sm text-mute" data-testid="user-act-note">{t('users.act_note')}</p>}
    </FormDialog>
  );
}

function DeletedTab() {
  const { t } = useTranslation();
  const q = useDeletedUsers(true);
  const [act, setAct] = useState<Act | null>(null);
  const items = q.data ?? [];
  return (
    <div className="card overflow-x-auto" data-testid="users-deleted">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-card2 text-mute"><tr><th className="p-2 text-start">{t('users.name')}</th><th className="p-2 text-start">{t('common.reason')}</th><th className="p-2 text-start">{t('users.deleted_by')}</th><th className="p-2 text-start">{t('users.deleted_at')}</th><th className="p-2" /></tr></thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id} className="border-b border-line" data-testid={`deleted-row-${d.employee_id}`}>
              <td className="p-2"><span className="inline-flex items-baseline gap-1">{d.display_name}{d.employee_id && <IdBadge employeeId={d.employee_id} />}</span></td>
              <td className="p-2 text-mute">{d.delete_reason}</td>
              <td className="p-2">{d.deleted_by?.display_name}</td>
              <td className="mono p-2 text-xs">{d.deleted_at?.slice(0, 10)}</td>
              <td className="p-2 text-end">
                <button className="btn" data-testid={`user-restore-${d.employee_id}`} disabled={d.can_restore === false} title={d.restore_blocked_reason ?? undefined} onClick={() => setAct({ kind: 'restore', deleted: d })}><RotateCcw size={14} />{t('users.restore')}</button>
                {d.can_restore === false && <div className="mt-1 text-xs text-lateInk" data-testid={`restore-blocked-${d.employee_id}`}>{d.restore_blocked_reason}</div>}
              </td>
            </tr>
          ))}
          {q.isSuccess && !items.length && <tr><td colSpan={5} className="p-6 text-center text-mute" data-testid="deleted-empty">{t('users.deleted_empty')}</td></tr>}
        </tbody>
      </table>
      {act && <ActDialog act={act} onClose={() => setAct(null)} />}
    </div>
  );
}

export function Users() {
  const { t } = useTranslation();
  const me = useMe(true);
  const [tab, setTab] = useState<'active' | 'deleted'>('active');
  const [act, setAct] = useState<Act | null>(null);
  const [f, setF] = useState({ q: '', status: '', role_id: '' });
  const [sel, setSel] = useState<Record<string, User>>({});
  const [dlg, setDlg] = useState(false);
  const [creating, setCreating] = useState(false);
  const canCreate = isAdmin(me.data) || !!me.data?.effective.grants.some((g) => (g.action as string) === 'create' && ['users', 'admin.users'].includes(g.module_key as string));
  const users = useUsers(f), roles = useRoles();
  const items = users.data?.items ?? [];
  const chosen = Object.values(sel);
  const toggle = (u: User) => setSel((s) => { const n = { ...s }; if (n[u.id]) delete n[u.id]; else n[u.id] = u; return n; });
  return (
    <div data-testid="page-users">
      <h1 className="text-2xl font-bold">{t('users.title')}</h1>
      <p className="mb-4 text-mute">{t('users.subtitle')}</p>
      <div role="tablist" className="mb-3 flex gap-1">
        {(['active', 'deleted'] as const).map((k) => <button key={k} role="tab" aria-selected={tab === k} data-testid={`users-tab-${k}`} className={`btn ${tab === k ? 'btn-accent' : ''}`} onClick={() => setTab(k)}>{t(`users.tab_${k}`)}</button>)}
      </div>
      {tab === 'deleted' ? <DeletedTab /> : <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input max-w-64" data-testid="users-search" aria-label={t('users.search')} placeholder={t('users.search')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select className="input w-auto" data-testid="users-filter-status" aria-label={t('users.status')} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">{t('users.all_statuses')}</option>
          {['active', 'pending_assignment', 'suspended', 'disabled'].map((s) => <option key={s} value={s}>{t(`userStatus.${s}`)}</option>)}
        </select>
        <select className="input w-auto" data-testid="users-filter-role" aria-label={t('users.role')} value={f.role_id} onChange={(e) => setF({ ...f, role_id: e.target.value })}>
          <option value="">{t('users.all_roles')}</option>
          {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name_en}</option>)}
        </select>
        <span className="flex-1" />
        {canCreate && <button className="btn" data-testid="users-new" onClick={() => setCreating(true)}><UserRoundPlus size={16} />{t('newUser.open')}</button>}
        <button className="btn btn-accent" data-testid="users-assign" onClick={() => setDlg(true)}><UserPlus size={16} />{chosen.length ? t('users.assign_selected', { count: chosen.length }) : t('users.assign')}</button>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-start text-mute"><tr>
            <th className="w-10 p-2" /><th className="p-2 text-start">{t('users.name')}</th><th className="p-2 text-start">{t('users.email')}</th><th className="p-2 text-start">{t('users.status')}</th><th className="p-2 text-start">{t('users.flags')}</th><th className="p-2" />
          </tr></thead>
          <tbody data-testid="users-list">
            {items.map((u) => (
              <tr key={u.id} className="border-b border-line hover:bg-hover" data-testid={`user-row-${u.employee_id ?? u.id}`}>
                <td className="p-2"><input type="checkbox" aria-label={t('users.select', { name: u.display_name })} data-testid={`user-select-${u.employee_id ?? u.id}`} checked={!!sel[u.id]} onChange={() => toggle(u)} /></td>
                <td className="p-2"><span className="inline-flex items-baseline gap-1">{u.display_name}{u.employee_id && <IdBadge employeeId={u.employee_id} />}</span></td>
                <td className="p-2 text-mute" dir="ltr">{u.email}</td>
                <td className="p-2"><span className={`chip ${STATUS_TONE[u.status]}`} data-testid={`user-status-${u.employee_id ?? u.id}`}>{t(`userStatus.${u.status}`)}</span></td>
                <td className="p-2"><span className="inline-flex flex-wrap gap-1"><LocalBadges user={u} /><MfaBadge user={u} /></span></td>
                <td className="p-2 text-end"><span className="inline-flex gap-1">
                  <Link className="btn" data-testid={`user-open-${u.employee_id ?? u.id}`} to={`/admin/users/${u.id}`}>{t('users.open')}</Link>
                  {(u.status === 'suspended' || u.status === 'disabled')
                    ? <button className="btn" data-testid={`user-reactivate-${u.employee_id ?? u.id}`} onClick={() => setAct({ kind: 'reactivate', user: u })}><RotateCcw size={14} />{t('users.reactivate')}</button>
                    : <button className="btn" data-testid={`user-deactivate-${u.employee_id ?? u.id}`} disabled={u.id === me.data?.user.id} title={u.id === me.data?.user.id ? t('errors.self_beneficiary') : undefined} onClick={() => setAct({ kind: 'deactivate', user: u })}><UserX size={14} />{t('users.deactivate')}</button>}
                  <button className="btn" data-testid={`user-delete-${u.employee_id ?? u.id}`} disabled={u.id === me.data?.user.id} title={u.id === me.data?.user.id ? t('errors.self_beneficiary') : undefined} onClick={() => setAct({ kind: 'delete', user: u })}><Trash2 size={14} />{t('users.delete')}</button></span></td>
              </tr>
            ))}
            {users.isSuccess && !items.length && <tr><td colSpan={6} className="p-6 text-center text-mute" data-testid="users-empty">{t('users.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
      </>}
      {act && <ActDialog act={act} onClose={() => setAct(null)} />}
      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
      {dlg && <AssignDialog open onClose={() => { setDlg(false); setSel({}); }} initialMode={chosen.length === 1 ? 'person' : 'role'}
        initialPeople={chosen.map((u) => ({ id: u.id, display_name: u.display_name, employee_id: u.employee_id ?? '' }))} />}
    </div>
  );
}
