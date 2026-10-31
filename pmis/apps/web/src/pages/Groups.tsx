import { Plus, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAddMembers, useCreateGroup, useGroup, useGroups, useRemoveMember } from '@/api/admin';
import type { UserPickerItem } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { PeoplePicker } from '@/components/PeoplePicker';
import { IdBadge } from '@/components/PersonTag';
import { useToast } from '@/components/Toast';
import { STATUS_TONE } from './Users';

export function Groups() {
  const { t } = useTranslation();
  const toast = useToast();
  const groups = useGroups();
  const [open, setOpen] = useState<string | null>(null);
  const sel = open ?? groups.data?.[0]?.id ?? null;
  const g = useGroup(sel);
  const create = useCreateGroup(), add = useAddMembers(sel ?? ''), rm = useRemoveMember(sel ?? '');
  const [dlg, setDlg] = useState<null | 'new' | 'add' | { id: string; name: string }>(null);
  const [name, setName] = useState('');
  const [people, setPeople] = useState<UserPickerItem[]>([]);
  const close = () => { setDlg(null); setName(''); setPeople([]); };
  return (
    <div data-testid="page-groups">
      <div className="mb-4 flex items-center gap-3">
        <div className="me-auto"><h2 className="text-lg font-bold">{t('groups.title')}</h2><p className="text-mute">{t('groups.subtitle')}</p></div>
        <button className="btn btn-accent" data-testid="group-new" onClick={() => setDlg('new')}><Plus size={16} />{t('groups.new')}</button>
      </div>
      <div className="grid gap-4 md:grid-cols-[260px_1fr]">
        <ul className="card p-1" data-testid="groups-list">
          {(groups.data ?? []).map((x) => (
            <li key={x.id}><button className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-start text-sm ${x.id === sel ? 'bg-sideOn font-semibold' : 'hover:bg-hover'}`} data-testid={`group-${x.id}`} aria-current={x.id === sel} onClick={() => setOpen(x.id)}>
              <span>{x.name}</span><span className="chip bg-card2 text-mute">{x.member_count}</span></button></li>
          ))}
        </ul>
        <section className="card p-4" data-testid="group-detail">
          {g.data && (<>
            <div className="mb-2 flex items-center gap-2"><h2 className="me-auto text-lg font-bold" data-testid="group-name">{g.data.name}</h2>
              <button className="btn" data-testid="group-add" onClick={() => setDlg('add')}><Plus size={16} />{t('groups.add_members')}</button></div>
            <ul className="divide-y divide-line">
              {(g.data.members ?? []).map((m) => (
                <li key={m.user.id} className="flex items-center gap-2 py-2 text-sm" data-testid={`member-${m.user.employee_id}`}>
                  <span className="inline-flex items-baseline gap-1">{m.user.display_name}{m.user.employee_id && <IdBadge employeeId={m.user.employee_id} />}</span>
                  {m.status && <span className={`chip ${STATUS_TONE[m.status]}`}>{t(`userStatus.${m.status}`)}</span>}
                  <span className="flex-1" />
                  <button className="btn" data-testid={`member-remove-${m.user.employee_id}`} onClick={() => setDlg({ id: m.user.id, name: m.user.display_name })}><UserMinus size={14} />{t('common.remove')}</button>
                </li>
              ))}
              {!(g.data.members ?? []).length && <li className="py-3 text-mute">{t('groups.empty')}</li>}
            </ul>
          </>)}
        </section>
      </div>
      {dlg === 'new' && (
        <FormDialog open onClose={close} testid="group-dialog" title={t('groups.new')} disabled={name.trim().length < 2} busy={create.isPending} error={create.isError ? errText(create.error, t) : null}
          onSubmit={(reason) => create.mutate({ name: name.trim(), reason }, { onSuccess: (r) => { setOpen(r.id); toast(t('groups.saved')); close(); } })}>
          <label className="block text-sm font-semibold">{t('groups.name')}<input className="input mt-1 font-normal" data-testid="group-name-input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        </FormDialog>
      )}
      {dlg === 'add' && (
        <FormDialog open onClose={close} testid="members-dialog" title={t('groups.add_members')} disabled={!people.length} busy={add.isPending} error={add.isError ? errText(add.error, t) : null}
          onSubmit={(reason) => add.mutate({ user_ids: people.map((p) => p.id), reason }, { onSuccess: (r) => { toast(t('assign.result', { done: r.done.length, skipped: r.skipped.length })); close(); } })}>
          <PeoplePicker id="members-people" value={people} onChange={setPeople} />
        </FormDialog>
      )}
      {dlg && typeof dlg === 'object' && (
        <FormDialog open onClose={close} testid="remove-dialog" title={t('groups.remove_title', { name: dlg.name })} busy={rm.isPending} error={rm.isError ? errText(rm.error, t) : null}
          onSubmit={(reason) => { rm.mutate({ userId: dlg.id, reason }, { onSuccess: () => toast(t('groups.removed')), onError: (e) => toast(errText(e, t), 'err') }); close(); }} />
      )}
    </div>
  );
}
