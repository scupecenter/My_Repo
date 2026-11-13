import { Send, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type UserInvitation, useInvitationAction, useInvitations } from '@/api/invitations';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

const TONE: Record<string, string> = { pending: 'bg-waitBg text-waitInk', accepted: 'bg-doneBg text-doneInk', revoked: 'bg-lockBg text-lockInk', expired: 'bg-lateBg text-lateInk' };

function ActDialog({ act, onClose }: { act: { kind: 'resend' | 'revoke'; inv: UserInvitation }; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const m = useInvitationAction(act.kind);
  return (
    <FormDialog open onClose={onClose} testid="invitation-act-dialog" title={t(`invite.${act.kind}_title`, { email: act.inv.email })} submitLabel={t(`invite.${act.kind}`)} busy={m.isPending} error={m.isError ? errText(m.error, t) : null}
      onSubmit={(reason) => m.mutate({ id: act.inv.id, reason }, { onSuccess: () => { toast(t(`invite.done_${act.kind}`)); onClose(); } })}>
      {act.kind === 'resend' && <p className="rounded-md bg-card2 p-2 text-sm text-mute">{t('invite.resend_note')}</p>}
    </FormDialog>
  );
}

/** Users & Roles, "Invitations" tab: every invitation with its state; resend and revoke. The link itself is never shown (it exists only in the mail). */
export function InvitationsTab() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [f, setF] = useState({ q: '', status: '' });
  const [act, setAct] = useState<{ kind: 'resend' | 'revoke'; inv: UserInvitation } | null>(null);
  const q = useInvitations(f);
  const items = q.data?.items ?? [];
  return (
    <div data-testid="invitations-tab">
      <div className="mb-3 flex flex-wrap gap-2">
        <input className="input max-w-64" data-testid="invitations-search" aria-label={t('users.search')} placeholder={t('users.search')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select className="input w-auto" data-testid="invitations-filter-status" aria-label={t('users.status')} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">{t('users.all_statuses')}</option>
          {['pending', 'accepted', 'revoked', 'expired'].map((s) => <option key={s} value={s}>{t(`invite.status.${s}`)}</option>)}
        </select>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-mute"><tr>
            <th className="p-2 text-start">{t('users.name')}</th><th className="p-2 text-start">{t('users.email')}</th><th className="p-2 text-start">{t('invite.roles')}</th>
            <th className="p-2 text-start">{t('users.status')}</th><th className="p-2 text-start">{t('invite.expires')}</th><th className="p-2 text-start">{t('invite.invited_by')}</th><th className="p-2" />
          </tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-b border-line" data-testid={`invitation-row-${i.email}`}>
                <td className="p-2">{i.display_name}{i.elevated && <span className="chip ms-1 bg-lateBg text-lateInk">{t('invite.elevated')}</span>}</td>
                <td className="p-2 text-mute" dir="ltr">{i.email}</td>
                <td className="p-2 text-mute">{i.assignments.map((a) => (ar && a.role?.name_ar) || a.role?.name_en).filter(Boolean).join(', ') || '-'}</td>
                <td className="p-2"><span className={`chip ${TONE[i.status]}`} data-testid={`invitation-status-${i.email}`}>{t(`invite.status.${i.status}`)}</span></td>
                <td className="mono p-2 text-xs">{fmtDateTime(i.expires_at, i18n.language)}</td>
                <td className="p-2">{i.invited_by.name}</td>
                <td className="p-2 text-end"><span className="inline-flex gap-1">
                  {(i.status === 'pending' || i.status === 'expired') && <button className="btn" data-testid={`invitation-resend-${i.email}`} onClick={() => setAct({ kind: 'resend', inv: i })}><Send size={14} />{t('invite.resend')}</button>}
                  {i.status === 'pending' && <button className="btn" data-testid={`invitation-revoke-${i.email}`} onClick={() => setAct({ kind: 'revoke', inv: i })}><X size={14} />{t('invite.revoke')}</button>}
                </span></td>
              </tr>
            ))}
            {q.isSuccess && !items.length && <tr><td colSpan={7} className="p-6 text-center text-mute" data-testid="invitations-empty">{t('invite.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
      {act && <ActDialog act={act} onClose={() => setAct(null)} />}
    </div>
  );
}
