import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationPersonalSettings, useSetNotificationPersonalSettings, type NotificationPersonalSettings } from '@/api/notificationPersonal';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';

/**
 * Settings > Alerts > Policy: the org switches of the personal notification layer (contract 0.15.531). People may choose their own types, a scheduled
 * do-not-disturb and a snooze unless this is off; the dedupe window drops the same unread notice sent again; decisions are kept for N days. Audited, reason required.
 */
export function NotificationPersonalCard() {
  const q = useNotificationPersonalSettings();
  if (!q.data) return <QueryFallback queries={[q]} testid="npp-org-loading" />;
  return <Card key={q.data.version} s={q.data} />;
}

function Card({ s }: { s: NotificationPersonalSettings }) {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useSetNotificationPersonalSettings();
  const [d, setD] = useState({ allow_personal: s.allow_personal, allow_dnd: s.allow_dnd, dedupe: String(s.dedupe_minutes), keep: String(s.decision_retention_days) });
  const [open, setOpen] = useState(false);
  const dedupe = /^\d{1,4}$/.test(d.dedupe) ? Number(d.dedupe) : -1;
  const keep = /^\d{1,3}$/.test(d.keep) ? Number(d.keep) : -1;
  const bad = dedupe < 0 || dedupe > 1440 || keep < 1 || keep > 365;
  const dirty = d.allow_personal !== s.allow_personal || d.allow_dnd !== s.allow_dnd || dedupe !== s.dedupe_minutes || keep !== s.decision_retention_days;
  return (
    <section className="card space-y-3 p-4" data-testid="np-personal">
      <h2 className="font-bold">{t('npp.org_title')}</h2>
      <p className="text-sm text-mute">{t('npp.org_note')}</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="npp-org-personal" checked={d.allow_personal} onChange={(e) => setD({ ...d, allow_personal: e.target.checked })} />{t('npp.org_personal')}</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="npp-org-dnd" checked={d.allow_dnd} disabled={!d.allow_personal} onChange={(e) => setD({ ...d, allow_dnd: e.target.checked })} />{t('npp.org_dnd')}</label>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">{t('npp.org_dedupe')}<input inputMode="numeric" className="input mt-1 block w-28" data-testid="npp-org-dedupe" value={d.dedupe} onChange={(e) => setD({ ...d, dedupe: e.target.value })} aria-invalid={dedupe < 0 || dedupe > 1440} /></label>
        <label className="text-sm">{t('npp.org_keep')}<input inputMode="numeric" className="input mt-1 block w-28" data-testid="npp-org-keep" value={d.keep} onChange={(e) => setD({ ...d, keep: e.target.value })} aria-invalid={keep < 1 || keep > 365} /></label>
      </div>
      <p className="text-xs text-mute">{t('npp.org_dedupe_note')}</p>
      <button type="button" className="btn btn-accent" data-testid="npp-org-save" disabled={!dirty || bad} onClick={() => setOpen(true)}>{t('common.save')}</button>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="npp-org-dialog" title={t('npp.org_title')} busy={save.isPending} error={save.isError ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ version: s.version, body: { allow_personal: d.allow_personal, allow_dnd: d.allow_dnd, dedupe_minutes: dedupe, decision_retention_days: keep, reason } },
            { onSuccess: () => { toast(t('settings.audited')); setOpen(false); } })} />
      )}
    </section>
  );
}
