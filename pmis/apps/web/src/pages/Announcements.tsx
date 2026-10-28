import { Megaphone, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useGroups, useRoles } from '@/api/admin';
import { useMe } from '@/api/hooks';
import { useAnnouncements, useDepartments, useSendAnnouncement } from '@/api/msg';
import type { UserPickerItem } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { PeoplePicker } from '@/components/PeoplePicker';
import { useToast } from '@/components/Toast';
import { errorCodes, fmtDateTime } from '@/lib/time';

const TITLE_MAX = 200, BODY_MAX = 5000;

/** A scrolling checklist of named choices (groups, roles, departments). */
function Checklist({ id, label, options, value, onChange }: { id: string; label: string; options: { id: string; name: string; testid: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  return (
    <fieldset data-testid={id}>
      <legend className="text-sm font-semibold">{label}{value.length > 0 && <span className="ms-1 text-mute">({value.length})</span>}</legend>
      <div className="card mt-1 max-h-32 overflow-y-auto p-2">
        {options.length === 0 && <p className="text-sm text-mute">{t('annNew.none_defined')}</p>}
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 py-0.5 text-sm font-normal">
            <input type="checkbox" data-testid={o.testid} checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} />{o.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NewAnnouncementDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const send = useSendAnnouncement();
  const groups = useGroups(), roles = useRoles(), depts = useDepartments();
  const ar = i18n.language === 'ar';
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [all, setAll] = useState(false);
  const [users, setUsers] = useState<UserPickerItem[]>([]);
  const [gs, setGs] = useState<string[]>([]);
  const [rs, setRs] = useState<string[]>([]);
  const [ds, setDs] = useState<string[]>([]);
  const empty = !all && !users.length && !gs.length && !rs.length && !ds.length;
  const noRecipients = send.isError && errorCodes(send.error).includes('no_recipients');
  const bad = !title.trim() || !body.trim() || empty;
  return (
    <FormDialog open onClose={onClose} wide withReason={false} testid="ann-new" title={t('annNew.title')} submitLabel={t('annNew.send')} busy={send.isPending} disabled={bad}
      error={send.isError ? (noRecipients ? t('annNew.no_recipients') : errText(send.error, t)) : null}
      onSubmit={() => send.mutate(
        { title: title.trim(), body, audience: all ? { all: true } : { all: false, user_ids: users.map((u) => u.id), group_ids: gs, role_ids: rs, department_ids: ds } },
        { onSuccess: (a) => { toast(t('annNew.sent', { count: a.recipient_count })); onClose(); } })}>
      <p className="flex gap-2 rounded-md bg-waitBg p-2 text-sm text-waitInk" role="note" data-testid="ann-warning"><TriangleAlert size={16} className="mt-0.5 shrink-0" /><span>{t('annNew.warning')}</span></p>
      <label className="block text-sm font-semibold">{t('annNew.field_title')}<input className="input mt-1 font-normal" data-testid="ann-title" maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('annNew.field_body')}<textarea className="input mt-1 min-h-28 font-normal" data-testid="ann-body" maxLength={BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <div className="space-y-2 rounded-md border border-line p-3">
        <div className="text-sm font-semibold">{t('annNew.audience')}</div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="ann-all" checked={all} onChange={(e) => setAll(e.target.checked)} />{t('annNew.everyone')}</label>
        {!all && (
          <div className="space-y-2">
            <div><span className="text-sm font-semibold">{t('annNew.users')}</span><PeoplePicker id="ann-users" value={users} onChange={setUsers} /></div>
            <Checklist id="ann-groups" label={t('annNew.groups')} value={gs} onChange={setGs} options={(groups.data ?? []).filter((g) => g.is_active !== false).map((g) => ({ id: g.id, name: g.name, testid: `ann-group-${g.id}` }))} />
            <Checklist id="ann-roles" label={t('annNew.roles')} value={rs} onChange={setRs} options={(roles.data ?? []).filter((r) => r.is_active).map((r) => ({ id: r.id, name: (ar && r.name_ar) || r.name_en, testid: `ann-role-${r.code}` }))} />
            <Checklist id="ann-depts" label={t('annNew.departments')} value={ds} onChange={setDs} options={(depts.data ?? []).map((d) => ({ id: d.id, name: (ar && d.name_ar) || d.name_en, testid: `ann-dept-${d.code}` }))} />
          </div>
        )}
        {empty && <p className="text-sm text-mute" data-testid="ann-audience-hint">{t('annNew.audience_hint')}</p>}
      </div>
    </FormDialog>
  );
}

export function Announcements() {
  const { t, i18n } = useTranslation();
  const me = useMe(true);
  const q = useAnnouncements();
  const [creating, setCreating] = useState(false);
  if (me.data && !me.data.effective.nav.includes('announcements' as never) && !me.data.is_system_admin) return <p role="alert" data-testid="ann-forbidden" className="text-lateInk">{t('errors.forbidden')}</p>;
  const items = q.data ?? [];
  return (
    <div data-testid="page-announcements">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="me-auto"><h1 className="text-2xl font-bold">{t('nav.announcements')}</h1><p className="text-mute">{t('ann.subtitle')}</p></div>
        <button className="btn btn-accent" data-testid="ann-new-open" onClick={() => setCreating(true)}><Megaphone size={16} />{t('ann.new')}</button>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-mute"><tr>
            <th className="p-2 text-start">{t('ann.col_title')}</th><th className="p-2 text-start">{t('ann.col_sender')}</th><th className="p-2 text-start">{t('ann.col_sent')}</th>
            <th className="p-2 text-end">{t('ann.recipients')}</th><th className="p-2 text-end">{t('ann.agree')}</th><th className="p-2 text-end">{t('ann.disagree')}</th><th className="p-2 text-end">{t('ann.pending')}</th>
          </tr></thead>
          <tbody data-testid="ann-list">
            {items.map((a) => (
              <tr key={a.id} className="border-b border-line hover:bg-hover" data-testid={`ann-row-${a.id}`}>
                <td className="p-2 font-semibold"><Link to={`/admin/announcements/${a.id}`} data-testid={`ann-open-${a.id}`} className="hover:underline" dir="auto">{a.title}</Link></td>
                <td className="p-2">{a.created_by.display_name}</td>
                <td className="p-2 text-mute">{fmtDateTime(a.created_at, i18n.language)}</td>
                <td className="p-2 text-end" data-testid={`ann-count-${a.id}-recipients`}>{a.recipient_count}</td>
                <td className="p-2 text-end text-doneInk" data-testid={`ann-count-${a.id}-agree`}>{a.agree_count}</td>
                <td className="p-2 text-end text-lateInk" data-testid={`ann-count-${a.id}-disagree`}>{a.disagree_count}</td>
                <td className="p-2 text-end text-waitInk" data-testid={`ann-count-${a.id}-pending`}>{a.pending_count}</td>
              </tr>
            ))}
            {q.isSuccess && !items.length && <tr><td colSpan={7} className="p-6 text-center text-mute" data-testid="ann-empty">{t('ann.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <NewAnnouncementDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
