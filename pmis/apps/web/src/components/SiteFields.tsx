import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProposeSiteChange, useUpdateSite, type SiteCustomField } from '@/api/qc';
import type { SiteDetail } from '@/api/types';
import { taskErrorMessage } from '@/lib/taskErrors';
import { useToast } from './Toast';

/**
 * The site's custom fields (owner answer Q130: the yes/no field near_airport). A yes/no field the caller may edit is a switch; the others are shown as
 * values. A change goes through PATCH /sites/{id} with the site's version, and the conditional documents that read the field follow by themselves.
 * Q225 (contract 0.12.10): a field that changes permits or scope (`requires_approval`) is not saved directly: the switch opens a proposal with a reason,
 * which becomes a Change Control draft; the site keeps its approved value until L2 approves it.
 */
export function SiteFields({ site }: { site: SiteDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const save = useUpdateSite(site.id);
  const propose = useProposeSiteChange(site.id);
  const [draft, setDraft] = useState<{ code: string; value: unknown; reason: string } | null>(null);
  const fields = (site.custom_fields ?? []) as SiteCustomField[];
  if (!fields.length) return null;
  const values = (site.custom ?? {}) as Record<string, unknown>;
  const label = (f: SiteCustomField) => (i18n.language === 'ar' && f.label_ar) || f.label_en;
  const show = (v: unknown) => (v === true ? t('common.yes') : v === false ? t('common.no') : v === undefined || v === null || v === '' ? '—' : String(v));
  const send = () => {
    if (!draft) return;
    propose.mutate({ custom: { [draft.code]: draft.value }, reason: draft.reason.trim() }, {
      onSuccess: (r) => { setDraft(null); toast(t('siteFields.proposed', { id: r.items[0]?.change_id ?? '' })); },
      onError: (err) => toast(taskErrorMessage(t as never, err) || t('siteFields.propose_failed'), 'err'),
    });
  };
  return (
    <section className="mt-3 rounded-md border border-line p-3 text-sm" aria-label={t('siteFields.title')} data-testid="site-fields">
      <div className="flex flex-wrap items-center gap-4">
        <span className="font-semibold">{t('siteFields.title')}</span>
        {fields.map((f) => {
          const v = values[f.code];
          if (f.type === 'bool' && f.can_edit && f.requires_approval) {
            const pending = draft?.code === f.code;
            return (
              <label key={f.code} className="inline-flex items-center gap-2" data-testid={`site-field-${f.code}`}>
                <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" data-testid={`site-field-input-${f.code}`} checked={pending ? draft!.value === true : v === true}
                  disabled={propose.isPending} onChange={(e) => setDraft(e.target.checked === (v === true) ? null : { code: f.code, value: e.target.checked, reason: '' })} />
                {label(f)}
                <span className="chip bg-card2 text-xs" data-testid={`site-field-approval-${f.code}`} title={t('siteFields.requires_approval_hint')}>{t('siteFields.requires_approval')}</span>
              </label>
            );
          }
          if (f.type === 'bool' && f.can_edit) {
            return (
              <label key={f.code} className="inline-flex items-center gap-2" data-testid={`site-field-${f.code}`}>
                <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" data-testid={`site-field-input-${f.code}`} checked={v === true} disabled={save.isPending}
                  onChange={(e) => save.mutate({ version: site.version, custom: { [f.code]: e.target.checked } }, {
                    onSuccess: () => toast(t('siteFields.saved')),
                    onError: (err) => toast(taskErrorMessage(t as never, err) || t('siteFields.failed'), 'err'),
                  })} />
                {label(f)}
              </label>
            );
          }
          return <span key={f.code} data-testid={`site-field-${f.code}`}><span className="text-mute">{label(f)}:</span> <b>{show(v)}</b></span>;
        })}
      </div>
      {draft && (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="site-field-proposal">
          <span className="text-mute">{t('siteFields.propose_note', { field: label(fields.find((f) => f.code === draft.code)!), value: show(draft.value) })}</span>
          <input className="input min-w-[16rem] flex-1" aria-label={t('siteFields.reason')} placeholder={t('siteFields.reason')} data-testid="site-field-proposal-reason"
            value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
          <button className="btn btn-primary" data-testid="site-field-proposal-send" disabled={!draft.reason.trim() || propose.isPending} onClick={send}>{t('siteFields.propose')}</button>
          <button className="btn" onClick={() => setDraft(null)}>{t('common.cancel')}</button>
        </div>
      )}
    </section>
  );
}
