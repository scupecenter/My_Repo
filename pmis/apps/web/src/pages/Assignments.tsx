import { UserPlus, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BulkError, useAssignments, useEndByRole, useRoles } from '@/api/admin';
import { useRegions } from '@/api/sites';
import { AssignDialog } from '@/components/AssignDialog';
import { errText, FormDialog } from '@/components/FormDialog';
import { PersonTag } from '@/components/PersonTag';
import { useToast } from '@/components/Toast';

/** By-role view of assignments (`GET /assignments`): pick a role, assign many people at once, or end many rows at once. */
export function Assignments() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const toast = useToast();
  const roles = useRoles(), regions = useRegions();
  const [roleId, setRoleId] = useState(''), [ended, setEnded] = useState(false);
  const list = useAssignments({ role_id: roleId, include_ended: ended });
  const end = useEndByRole();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<null | 'assign' | 'end'>(null);
  const rows = (list.data?.pages ?? []).flatMap((p) => p.items);
  const total = list.data?.pages[0]?.page.total ?? 0;
  const rname = (r: { name_en: string; name_ar?: string | null }) => (ar && r.name_ar) || r.name_en;
  const regionName = (id: number) => { const r = regions.data?.find((x) => x.id === id); return r ? rname(r) : String(id); };
  const chosen = rows.filter((r) => sel.has(r.id) && r.is_active_now);
  const toggle = (id: string, v: boolean) => setSel((p) => { const n = new Set(p); if (v) n.add(id); else n.delete(id); return n; });
  const bulkErr = end.error instanceof BulkError ? end.error : null;
  return (
    <div data-testid="page-assignments">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="me-auto"><h2 className="text-lg font-bold">{t('assign.title_page')}</h2><p className="text-mute">{t('assign.subtitle')}</p></div>
        <button className="btn btn-accent" data-testid="assignments-assign" disabled={!roleId} onClick={() => setDlg('assign')}><UserPlus size={16} />{t('assign.assign_to_role')}</button>
        <button className="btn" data-testid="assignments-end" disabled={!chosen.length} onClick={() => { end.reset(); setDlg('end'); }}><UserMinus size={16} />{t('assign.end_submit')} ({chosen.length})</button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select className="input w-auto" data-testid="assignments-role" aria-label={t('users.role')} value={roleId} onChange={(e) => { setRoleId(e.target.value); setSel(new Set()); }}>
          <option value="">{t('assign.all_roles')}</option>
          {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.parent_role_id ? '— ' : ''}{rname(r)}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="assignments-ended" checked={ended} onChange={(e) => setEnded(e.target.checked)} />{t('assign.include_ended')}</label>
        <span className="text-sm text-mute" data-testid="assignments-total">{t('assign.total', { count: total })}</span>
      </div>
      <div className="card overflow-x-auto"><table className="w-full text-sm">
        <thead className="border-b border-line bg-card2 text-mute"><tr>
          <th className="w-8 p-2" /><th className="p-2 text-start">{t('assign.person')}</th><th className="p-2 text-start">{t('users.role')}</th><th className="p-2 text-start">{t('assign.level')}</th>
          <th className="p-2 text-start">{t('assign.regions')}</th><th className="p-2 text-start">{t('assign.modules')}</th><th className="p-2 text-start">{t('assign.validity')}</th><th className="p-2 text-start">{t('users.status')}</th>
        </tr></thead>
        <tbody data-testid="assignments-list">
          {rows.map((a) => (
            <tr key={a.id} className="border-b border-line" data-testid={`assignment-row-${a.user.employee_id}-${a.role.code}`}>
              <td className="p-2"><input type="checkbox" aria-label={t('assign.select_row')} data-testid={`assignment-select-${a.user.employee_id}-${a.role.code}`} disabled={!a.is_active_now} checked={sel.has(a.id)} onChange={(e) => toggle(a.id, e.target.checked)} /></td>
              <td className="p-2"><PersonTag name={a.user.display_name} employeeId={a.user.employee_id} /></td>
              <td className="p-2">{rname(a.role)}</td>
              <td className="p-2">{t(`level_name.${a.permission_level}`)} · {t(`team.${a.team ?? 'none'}`)}</td>
              <td className="p-2">{a.region_ids === 'all' ? t('common.all') : a.region_ids.map(regionName).join(', ')}</td>
              <td className="p-2">{a.module_keys === 'all' ? t('common.all') : t('deleg.n_modules', { count: a.module_keys.length })}</td>
              <td className="mono p-2 text-xs">{a.valid_from.slice(0, 10)} → {a.valid_to ? a.valid_to.slice(0, 10) : t('assign.open_ended')}</td>
              <td className="p-2"><span className={`chip ${a.is_active_now ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{a.is_active_now ? t('assign.status_active') : t('assign.status_ended')}</span></td>
            </tr>
          ))}
          {list.isSuccess && !rows.length && <tr><td colSpan={8} className="p-6 text-center text-mute" data-testid="assignments-empty">{t('assign.empty')}</td></tr>}
        </tbody>
      </table></div>
      {list.hasNextPage && <button className="btn mt-3" data-testid="assignments-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{t('assign.load_more')}</button>}
      {dlg === 'assign' && <AssignDialog open onClose={() => setDlg(null)} initialMode="role" initialRoleIds={[roleId]} />}
      {dlg === 'end' && (
        <FormDialog open onClose={() => setDlg(null)} testid="end-dialog" title={t('assign.end_title', { count: chosen.length })} submitLabel={t('assign.end_submit')} busy={end.isPending}
          error={end.isError ? (bulkErr ? `${errText(end.error, t)} (${bulkErr.result.failed.length})` : errText(end.error, t)) : null}
          onSubmit={(reason) => end.mutate({ rows: chosen, reason }, {
            onSuccess: (r) => { toast(r.failed.length ? t('assign.ended_partial', { done: r.done.length, failed: r.failed.length }) : t('assign.ended', { count: r.done.length })); setSel(new Set()); setDlg(null); },
          })}>
          <ul className="card max-h-40 overflow-y-auto p-1 text-sm">{chosen.map((a) => <li key={a.id} className="px-1 py-0.5">{a.user.display_name} · {rname(a.role)}</li>)}</ul>
        </FormDialog>
      )}
    </div>
  );
}
