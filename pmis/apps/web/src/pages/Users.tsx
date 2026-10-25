import { ShieldOff, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useRoles, useUsers } from '@/api/admin';
import type { User } from '@/api/types';
import { AssignDialog } from '@/components/AssignDialog';
import { IdBadge } from '@/components/PersonTag';

export const STATUS_TONE: Record<string, string> = { active: 'bg-doneBg text-doneInk', pending_assignment: 'bg-waitBg text-waitInk', suspended: 'bg-lateBg text-lateInk', disabled: 'bg-lockBg text-lockInk' };

export function MfaBadge({ user }: { user: Pick<User, 'mfa_exempt' | 'employee_id' | 'mfa_exempt_until'> }) {
  const { t } = useTranslation();
  if (!user.mfa_exempt) return null;
  return <span className="chip gap-1 bg-waitBg text-waitInk" data-testid={`mfa-badge-${user.employee_id}`} title={user.mfa_exempt_until ? t('mfa.until', { date: user.mfa_exempt_until.slice(0, 10) }) : t('mfa.until_revoked')}><ShieldOff size={12} />{t('mfa.badge')}</span>;
}

export function Users() {
  const { t } = useTranslation();
  const [f, setF] = useState({ q: '', status: '', role_id: '' });
  const [sel, setSel] = useState<Record<string, User>>({});
  const [dlg, setDlg] = useState(false);
  const users = useUsers(f), roles = useRoles();
  const items = users.data?.items ?? [];
  const chosen = Object.values(sel);
  const toggle = (u: User) => setSel((s) => { const n = { ...s }; if (n[u.id]) delete n[u.id]; else n[u.id] = u; return n; });
  return (
    <div data-testid="page-users">
      <h1 className="text-2xl font-bold">{t('users.title')}</h1>
      <p className="mb-4 text-mute">{t('users.subtitle')}</p>
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
        <button className="btn btn-accent" data-testid="users-assign" onClick={() => setDlg(true)}><UserPlus size={16} />{chosen.length ? t('users.assign_selected', { count: chosen.length }) : t('users.assign')}</button>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-start text-mute"><tr>
            <th className="w-10 p-2" /><th className="p-2 text-start">{t('users.name')}</th><th className="p-2 text-start">{t('users.email')}</th><th className="p-2 text-start">{t('users.status')}</th><th className="p-2 text-start">{t('users.flags')}</th><th className="p-2" />
          </tr></thead>
          <tbody data-testid="users-list">
            {items.map((u) => (
              <tr key={u.id} className="border-b border-line hover:bg-hover" data-testid={`user-row-${u.employee_id}`}>
                <td className="p-2"><input type="checkbox" aria-label={t('users.select', { name: u.display_name })} data-testid={`user-select-${u.employee_id}`} checked={!!sel[u.id]} onChange={() => toggle(u)} /></td>
                <td className="p-2"><span className="inline-flex items-baseline gap-1">{u.display_name}{u.employee_id && <IdBadge employeeId={u.employee_id} />}</span></td>
                <td className="p-2 text-mute" dir="ltr">{u.email}</td>
                <td className="p-2"><span className={`chip ${STATUS_TONE[u.status]}`} data-testid={`user-status-${u.employee_id}`}>{t(`userStatus.${u.status}`)}</span></td>
                <td className="p-2"><MfaBadge user={u} /></td>
                <td className="p-2 text-end"><Link className="btn" data-testid={`user-open-${u.employee_id}`} to={`/admin/users/${u.id}`}>{t('users.open')}</Link></td>
              </tr>
            ))}
            {users.isSuccess && !items.length && <tr><td colSpan={6} className="p-6 text-center text-mute" data-testid="users-empty">{t('users.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
      {dlg && <AssignDialog open onClose={() => { setDlg(false); setSel({}); }} initialMode={chosen.length === 1 ? 'person' : 'role'}
        initialPeople={chosen.map((u) => ({ id: u.id, display_name: u.display_name, employee_id: u.employee_id ?? '' }))} />}
    </div>
  );
}
