import { useRef, useState } from 'react';
import { Download, FileUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  COMPANY_TEMPLATES, downloadBlankCompanyTemplate, downloadCompanyTemplate, useCompanyOnboarding, useImportCompanyTemplate, useSetCompanyOnboarding,
  type OnboardingState,
} from '@/api/companies';
import { registerErrorMessage } from '@/lib/registerErrors';
import { QueryFallback } from './States';
import { useToast } from './Toast';

export const ONBOARDING_STATES: OnboardingState[] = ['not_started', 'in_progress', 'approved'];
export const stateChip: Record<string, string> = { not_started: 'bg-card2 text-mute', in_progress: 'bg-waitBg text-waitInk', approved: 'bg-doneBg text-doneInk', none: 'bg-card2 text-mute' };

/** The onboarding checklist of one company (Companies K4): one status per item, who approved and when, a note. No workflow: one change, audited. */
export function CompanyOnboarding({ party, canEdit }: { party: string; canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useCompanyOnboarding(party), set = useSetCompanyOnboarding(party);
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (!q.data) return <QueryFallback queries={[q]} testid="company-onb-loading" />;
  const label = (x: { label_en: string; label_ar?: string | null }) => (i18n.language === 'ar' && x.label_ar) || x.label_en;
  const change = (item: string, status: OnboardingState, note?: string) => set.mutate({ item, status, note }, {
    onSuccess: () => toast(t('companyOnb.saved')), onError: (e) => toast(registerErrorMessage(t, e), 'err'),
  });
  return (
    <section className="space-y-2" data-testid="company-onboarding">
      <h3 className="font-semibold">{t('companyOnb.title')}</h3>
      <p className="text-sm text-mute">{t('companyOnb.note')}</p>
      {q.data.length === 0 && <p className="text-mute" data-testid="company-onb-none">{t('companyOnb.none')}</p>}
      <ul className="divide-y">
        {q.data.map((i) => (
          <li key={i.code} className="flex flex-wrap items-center gap-3 py-2" data-testid={`company-onb-${i.code}`}>
            <span className="min-w-40 font-semibold">{label(i)}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${stateChip[i.status]}`} data-testid={`company-onb-chip-${i.code}`}>{t(`companyOnb.s_${i.status}`)}</span>
            {i.status === 'approved' && i.approver_name && <span className="text-xs text-mute">{t('companyOnb.approved_by', { name: i.approver_name, date: (i.decided_at ?? '').slice(0, 10) })}</span>}
            {canEdit ? (
              <>
                <select className="input w-40" aria-label={t('companyOnb.status')} data-testid={`company-onb-status-${i.code}`} value={i.status} onChange={(e) => change(i.code, e.target.value as OnboardingState, notes[i.code])}>
                  {ONBOARDING_STATES.map((s) => <option key={s} value={s}>{t(`companyOnb.s_${s}`)}</option>)}
                </select>
                <input className="input min-w-48 flex-1" aria-label={t('companyOnb.note_label')} placeholder={t('companyOnb.note_label')} data-testid={`company-onb-note-${i.code}`}
                  value={notes[i.code] ?? i.note ?? ''} onChange={(e) => setNotes({ ...notes, [i.code]: e.target.value })}
                  onBlur={() => { if (notes[i.code] !== undefined && notes[i.code] !== (i.note ?? '')) change(i.code, i.status, notes[i.code]); }} />
              </>
            ) : i.note ? <span className="text-sm text-mute">{i.note}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Import and export templates of the company records (Companies K4): the three approved templates, blank or filled with the companies picked, and the upload of a
 * filled file (applied at once; one refused row refuses the file). `parties` is the pick of the list; none means every company.
 */
export function CompanyTemplatesBar({ parties, canEdit }: { parties?: string[]; canEdit: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const imp = useImportCompanyTemplate();
  const file = useRef<HTMLInputElement>(null);
  const [errs, setErrs] = useState<string[]>([]);
  const get = async (id: string, filled: boolean) => {
    try {
      const n = await (filled ? downloadCompanyTemplate(id, parties) : downloadBlankCompanyTemplate(id));
      toast(t('grid.downloaded', { name: n }));
    } catch (e) { toast(registerErrorMessage(t, e), 'err'); }
  };
  const upload = (f: File | undefined) => {
    if (!f) return;
    setErrs([]);
    imp.mutate({ file: f }, {
      onSuccess: (r) => toast(t('companyOnb.imported', { added: r.added, updated: r.updated, unchanged: r.unchanged })),
      onError: (e) => {
        const list = ((e as { problem?: { errors?: { path: string; code: string }[] } }).problem?.errors ?? []).slice(0, 8).map((x) => `${x.path}: ${t(`fieldError.${x.code}`, { defaultValue: x.code })}`);
        setErrs(list);
        toast(registerErrorMessage(t, e), 'err');
      },
    });
    if (file.current) file.current.value = '';
  };
  return (
    <section className="space-y-2" data-testid="company-templates">
      <h3 className="font-semibold">{t('companyOnb.templates')}</h3>
      <p className="text-sm text-mute">{t('companyOnb.templates_note')}</p>
      <ul className="space-y-1">
        {COMPANY_TEMPLATES.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2" data-testid={`company-tpl-${x.key}`}>
            <span className="min-w-56 text-sm font-semibold">{t(`companyOnb.tpl_${x.key}`)}</span>
            <button type="button" className="btn px-2 py-1 text-xs" data-testid={`company-tpl-blank-${x.key}`} onClick={() => void get(x.id, false)}><Download size={14} />{t('companyOnb.blank')}</button>
            <button type="button" className="btn px-2 py-1 text-xs" data-testid={`company-tpl-filled-${x.key}`} onClick={() => void get(x.id, true)}><Download size={14} />{parties?.length ? t('companyOnb.filled_picked', { count: parties.length }) : t('companyOnb.filled_all')}</button>
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="flex items-center gap-2">
          <input ref={file} type="file" accept=".xlsx" className="hidden" data-testid="company-import-file" onChange={(e) => upload(e.target.files?.[0])} />
          <button type="button" className="btn btn-accent" data-testid="company-import" disabled={imp.isPending} onClick={() => file.current?.click()}><FileUp size={16} />{t('companyOnb.upload')}</button>
        </div>
      )}
      {errs.length > 0 && <ul role="alert" className="text-xs text-lateInk" data-testid="company-import-errors">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
    </section>
  );
}
