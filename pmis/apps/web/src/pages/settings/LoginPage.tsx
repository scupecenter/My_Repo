import { Info, Lock, Plus, Trash2, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLoginPage, useSetLoginPage } from '@/api/settings';
import type { SupportLink } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

type Draft = {
  announcement_en: string;
  announcement_ar: string;
  announcement_kind: 'info' | 'maintenance';
  animation: boolean;
  default_locale: 'en' | 'ar' | null;
  support_links: SupportLink[];
};

const clean = (d: Draft): Draft => ({
  ...d,
  announcement_en: d.announcement_en.trim(),
  announcement_ar: d.announcement_ar.trim(),
  support_links: d.support_links.map((l) => ({ label_en: l.label_en.trim(), label_ar: l.label_ar.trim(), url: l.url.trim() })),
});

/**
 * Settings > Screens > Login page (owner request 2026-11-26, migration 0197, contract 0.15.97): what the sign-in page shows —
 * the announcement, the background animation, the default language and the support links. Nothing here touches the sign-in
 * mechanism. A System Admin or a delegate of settings edit for all regions changes it with a reason and a step-up (audited).
 */
export function LoginPageSettings() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useLoginPage(), set = useSetLoginPage();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="loginpage-loading" />;
  const cur = q.data;
  const v: Draft = draft ?? {
    announcement_en: cur.announcement_en, announcement_ar: cur.announcement_ar, announcement_kind: cur.announcement_kind,
    animation: cur.animation, default_locale: cur.default_locale, support_links: cur.support_links.map((l) => ({ ...l })),
  };
  const dirty = JSON.stringify(clean(v)) !== JSON.stringify(clean({ ...cur, support_links: cur.support_links }));
  const ro = !cur.can_edit;
  const ar = i18n.language === 'ar';
  const patch = (p: Partial<Draft>) => setDraft({ ...v, ...p });
  const patchLink = (i: number, p: Partial<SupportLink>) => patch({ support_links: v.support_links.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const linksOk = v.support_links.every((l) => l.label_en.trim() && /^(https?:\/\/|mailto:)/i.test(l.url.trim()));
  return (
    <section className="card space-y-4 p-4" data-testid="page-login-settings">
      <div>
        <h2 className="font-bold">{t('loginPage.title')}</h2>
        <p className="text-sm text-mute">{t('loginPage.note')}</p>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t('loginPage.announcement')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-semibold text-mute" htmlFor="lp-ann-en">{t('loginPage.ann_en')}</label>
            <textarea id="lp-ann-en" dir="ltr" rows={2} maxLength={280} className="input mt-1 w-full" data-testid="lp-ann-en" disabled={ro}
              value={v.announcement_en} onChange={(e) => patch({ announcement_en: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-mute" htmlFor="lp-ann-ar">{t('loginPage.ann_ar')}</label>
            <textarea id="lp-ann-ar" dir="rtl" rows={2} maxLength={280} className="input mt-1 w-full" data-testid="lp-ann-ar" disabled={ro}
              value={v.announcement_ar} onChange={(e) => patch({ announcement_ar: e.target.value })} />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('loginPage.ann_kind')}>
          {(['info', 'maintenance'] as const).map((k) => (
            <label key={k} className={`chip cursor-pointer gap-1 border ${v.announcement_kind === k ? 'border-accent bg-accentSoft text-accentText' : 'border-line bg-card text-mute'}`} data-testid={`lp-kind-${k}`}>
              <input type="radio" name="lp-kind" className="sr-only" checked={v.announcement_kind === k} disabled={ro} onChange={() => patch({ announcement_kind: k })} />
              {k === 'info' ? <Info size={13} aria-hidden /> : <Wrench size={13} aria-hidden />}{t(`loginPage.kind_${k}`)}
            </label>
          ))}
          <span className="text-xs text-mute">{t('loginPage.ann_hide')}</span>
        </div>
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" data-testid="lp-animation" checked={v.animation} disabled={ro} onChange={(e) => patch({ animation: e.target.checked })} />
        <span><span className="font-semibold">{t('loginPage.animation')}</span><span className="block text-xs text-mute">{t('loginPage.animation_note')}</span></span>
      </label>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t('loginPage.locale')}</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('loginPage.locale')}>
          {([null, 'en', 'ar'] as const).map((l) => (
            <label key={String(l)} className={`chip cursor-pointer border ${v.default_locale === l ? 'border-accent bg-accentSoft text-accentText' : 'border-line bg-card text-mute'}`} data-testid={`lp-locale-${l ?? 'browser'}`}>
              <input type="radio" name="lp-locale" className="sr-only" checked={v.default_locale === l} disabled={ro} onChange={() => patch({ default_locale: l })} />
              {t(`loginPage.locale_${l ?? 'browser'}`)}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-mute">{t('loginPage.locale_note')}</p>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t('loginPage.links')}</legend>
        <p className="mb-2 text-xs text-mute">{t('loginPage.links_note')}</p>
        <div className="space-y-2">
          {v.support_links.map((l, i) => (
            <div key={i} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[1fr_1fr_1.4fr_auto]" data-testid={`lp-link-${i}`}>
              <input className="input" dir="ltr" maxLength={60} placeholder={t('loginPage.link_label_en')} data-testid={`lp-link-${i}-en`} disabled={ro} value={l.label_en} onChange={(e) => patchLink(i, { label_en: e.target.value })} />
              <input className="input" dir="rtl" maxLength={60} placeholder={t('loginPage.link_label_ar')} data-testid={`lp-link-${i}-ar`} disabled={ro} value={l.label_ar} onChange={(e) => patchLink(i, { label_ar: e.target.value })} />
              <input className="input" dir="ltr" maxLength={300} placeholder={t('loginPage.link_url')} data-testid={`lp-link-${i}-url`} disabled={ro} value={l.url} onChange={(e) => patchLink(i, { url: e.target.value })} />
              <button type="button" className="btn btn-danger" data-testid={`lp-link-${i}-remove`} disabled={ro} aria-label={t('loginPage.link_remove')} onClick={() => patch({ support_links: v.support_links.filter((_, j) => j !== i) })}>
                <Trash2 size={15} aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn mt-2 gap-1" data-testid="lp-link-add" disabled={ro || v.support_links.length >= 5} onClick={() => patch({ support_links: [...v.support_links, { label_en: '', label_ar: '', url: '' }] })}>
          <Plus size={15} aria-hidden />{t('loginPage.link_add')}
        </button>
      </fieldset>

      <div className="rounded-md bg-card2 p-3 text-sm" data-testid="lp-version-row">
        <p className="flex items-center gap-1 font-semibold"><Lock size={14} aria-hidden />{t('loginPage.version')}</p>
        <p className="mt-1"><span className="chip bg-card font-mono" data-testid="lp-version">{cur.server_version}</span></p>
        <p className="mt-2 text-xs text-mute">{t('loginPage.version_note')}</p>
      </div>

      <p className="text-xs text-mute" data-testid="lp-updated">
        {cur.updated_by && cur.updated_at
          ? t('loginPage.updated', { name: cur.updated_by.display_name, when: fmtDateTime(cur.updated_at, ar ? 'ar' : 'en') })
          : t('loginPage.never')}
      </p>
      {ro
        ? <p className="text-sm text-mute" data-testid="lp-readonly">{t('loginPage.readonly')}</p>
        : <button className="btn btn-accent" data-testid="lp-save" disabled={!dirty || !linksOk} onClick={() => setOpen(true)}>{t('common.save')}</button>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="lp-dialog" title={t('loginPage.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, ...clean(v), reason },
            { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
          <p className="text-sm text-mute" data-testid="lp-confirm">{t('loginPage.confirm')}</p>
        </FormDialog>
      )}
    </section>
  );
}
