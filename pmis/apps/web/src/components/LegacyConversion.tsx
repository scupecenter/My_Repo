import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApplyLegacy, useLegacyProposal } from '@/api/lists';
import type { RegisterRecord } from '@/api/types';
import { registerErrorMessage } from '@/lib/registerErrors';
import { FormDialog } from './FormDialog';
import { CellUser } from './RegisterFieldTypes';
import { useToast } from './Toast';

/**
 * Q111 (contract 0.12.5): a meeting saved with the old free text shows it read-only with a "Convert" action. The proposal (people and sites matched, one
 * action per line) is reviewed in a dialog: the person keeps or drops each item, then applies it once with a reason. Owners and due dates of the
 * proposed actions are filled in the form afterwards; nothing becomes a task by itself.
 */
export function LegacyConversion({ record, canEdit }: { record: RegisterRecord; canEdit: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const d = record.data as Record<string, unknown>;
  const has = ['attendees', 'linked_sites', 'minutes_ref', 'action_items'].some((k) => typeof d[k] === 'string' && d[k] !== '');
  const converted = typeof d.legacy_converted_at === 'string';
  const [open, setOpen] = useState(false);
  const prop = useLegacyProposal('meetings', record.id, open);
  const apply = useApplyLegacy('meetings');
  const [drop, setDrop] = useState<Set<string>>(new Set());
  // an action needs an owner and a due date (Q12): the person gives them for the converted actions, and can change each one in the form later
  const [owner, setOwner] = useState<string | null>(null);
  const [due, setDue] = useState('');
  if (!has) return null;
  const flip = (k: string) => setDrop((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const p = prop.data;
  return (
    <section className="rounded-md border border-line p-3 text-sm" data-testid="reg-legacy" aria-label={t('legacy.title')}>
      <div className="font-semibold">{t('legacy.title')}</div>
      <p className="text-mute">{converted ? t('legacy.converted', { date: d.legacy_converted_at as string }) : t('legacy.note')}</p>
      {!converted && canEdit && <button type="button" className="btn mt-2" data-testid="reg-legacy-open" onClick={() => setOpen(true)}>{t('legacy.convert')}</button>}
      {open && (
        <FormDialog open wide testid="reg-legacy-dialog" title={t('legacy.title')} busy={apply.isPending} disabled={!p || (p.action_items.length > 0 && (!owner || !due))}
          error={apply.isError ? registerErrorMessage(t, apply.error) : null} onClose={() => setOpen(false)}
          onSubmit={(reason) => p && apply.mutate({
            record,
            body: {
              reason,
              values: {
                attendee_users: p.attendees.filter((a) => !drop.has(`a:${a.user_id}`)).map((a) => a.user_id),
                linked_site_ids: p.sites.filter((s) => !drop.has(`s:${s.site_id}`)).map((s) => s.site_id),
                action_items_list: p.action_items.filter((_, i) => !drop.has(`x:${i}`)).map((x) => ({ description: x.description, status: x.status, owner, due_date: due })),
              },
            },
          }, { onSuccess: () => { toast(t('legacy.done')); setOpen(false); } })}>
          {!p ? <p>{t('common.loading')}</p> : (
            <div className="space-y-3 text-sm" data-testid="reg-legacy-proposal">
              <p className="text-mute">{t('legacy.review')}</p>
              <fieldset><legend className="font-semibold">{t('legacy.attendees')}</legend>
                {p.attendees.map((a) => <label key={a.user_id} className="flex gap-2"><input type="checkbox" data-testid={`reg-legacy-a-${a.user_id}`} checked={!drop.has(`a:${a.user_id}`)} onChange={() => flip(`a:${a.user_id}`)} />{a.display_name} <span className="mono text-mute">{a.employee_id}</span> <span className="text-mute">← {a.text}</span></label>)}
                {p.unmatched.attendees.length > 0 && <p className="text-lateInk" data-testid="reg-legacy-unmatched-a">{t('legacy.unmatched', { list: p.unmatched.attendees.join(', ') })}</p>}
              </fieldset>
              <fieldset><legend className="font-semibold">{t('legacy.sites')}</legend>
                {p.sites.map((s) => <label key={s.site_id} className="flex gap-2"><input type="checkbox" checked={!drop.has(`s:${s.site_id}`)} onChange={() => flip(`s:${s.site_id}`)} /><b className="mono">{s.site_code}</b></label>)}
                {p.unmatched.sites.length > 0 && <p className="text-lateInk" data-testid="reg-legacy-unmatched-s">{t('legacy.unmatched', { list: p.unmatched.sites.join(', ') })}</p>}
              </fieldset>
              <fieldset><legend className="font-semibold">{t('legacy.actions')}</legend>
                {p.action_items.map((x, i) => <label key={x.description} className="flex gap-2"><input type="checkbox" data-testid={`reg-legacy-x-${i}`} checked={!drop.has(`x:${i}`)} onChange={() => flip(`x:${i}`)} />{x.description}</label>)}
                {p.action_items.length > 0 && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div><span className="text-mute">{t('legacy.owner')}</span><CellUser id="reg-legacy-owner" value={owner} onChange={(v) => setOwner(v as string | null)} /></div>
                    <label className="text-mute">{t('legacy.due')}<input type="date" className="input mono" data-testid="reg-legacy-due" value={due} onChange={(e) => setDue(e.target.value)} /></label>
                  </div>
                )}
                <p className="text-mute">{t('legacy.actions_note')}</p>
              </fieldset>
              {p.minutes_note && <p className="rounded bg-waitBg p-2 text-waitInk" data-testid="reg-legacy-minutes">{t('legacy.minutes', { ref: p.minutes_note })}</p>}
            </div>
          )}
        </FormDialog>
      )}
    </section>
  );
}
