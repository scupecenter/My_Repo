import { Lock } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePutUiLogo, useSetUiIdentity, useSetUiLogoEnabled, useUiIdentity } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { BRAND_SWATCHES, BRANDS, type Brand } from '@/lib/brands';
import { APPEARANCE_OPTIONS, type Appearance, type AppearanceKey } from '@/lib/appearance';
import { fmtDateTime } from '@/lib/time';
import { API_BASE } from '@/api/client';
import { QueryFallback } from '@/components/States';

/** A small picture of a design (its light tokens): a sidebar with an active entry, a page with a card, an accent button and a soft chip. */
export function BrandPreview({ brand }: { brand: Brand }) {
  const s = BRAND_SWATCHES[brand];
  const bar = (w: string, c: string) => <span className="block h-1.5 rounded" style={{ width: w, background: c }} />;
  return (
    <div aria-hidden className="flex h-24 overflow-hidden rounded-md border border-line" data-testid={`identity-preview-${brand}`} dir="ltr">
      <div className="flex w-1/3 flex-col gap-1.5 p-2" style={{ background: s.side, borderInlineEnd: `1px solid ${s.line}` }}>
        {bar('70%', s.sideMute)}
        <span className="block rounded px-1 py-1" style={{ background: s.sideSel, borderInlineStart: `3px solid ${s.sideMark}` }}>{bar('80%', s.sideActive)}</span>
        {bar('60%', s.sideInk)}
        {bar('75%', s.sideInk)}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2" style={{ background: s.bg }}>
        <div className="flex flex-col gap-1 rounded p-1.5" style={{ background: s.card, border: `1px solid ${s.line}` }}>
          {bar('60%', s.ink)}
          {bar('40%', s.mute)}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded px-2 py-0.5 text-[10px] font-semibold" style={{ background: s.accent, color: s.accentInk }}>Aa</span>
          <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: s.accentSoft, color: s.accentText }}>Aa</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings, Identity & themes (owner decision 2026-11-19, migration 0130, contract 0.15.41): the organization default design and whether users may choose their own.
 * Every signed-in user sees it; a System Admin or a delegate of settings edit for all regions changes it with a reason and a step-up (audited). The light/dark
 * theme stays a separate choice of each user, and the status colours never change with the design.
 */
export function Identity() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useUiIdentity(), set = useSetUiIdentity();
  const putLogo = usePutUiLogo(), setLogo = useSetUiLogoEnabled();
  const [draft, setDraft] = useState<{ brand: Brand; allow: boolean; defaults: Appearance } | null>(null);
  const [open, setOpen] = useState(false);
  const [logoDialog, setLogoDialog] = useState<'upload' | 'hide' | 'show' | null>(null);
  const logoFile = useRef<File | null>(null);
  if (!q.data) return <QueryFallback queries={[q]} testid="identity-loading" />;
  const cur = q.data;
  const v = draft ?? { brand: cur.default_brand, allow: cur.allow_user_choice, defaults: cur.defaults ?? {} };
  const dirty = v.brand !== cur.default_brand || v.allow !== cur.allow_user_choice || JSON.stringify(v.defaults) !== JSON.stringify(cur.defaults ?? {});
  const ro = !cur.can_edit;
  const ar = i18n.language === 'ar';
  return (
    <section className="card space-y-4 p-4" data-testid="page-identity-settings">
      <div>
        <h2 className="font-bold">{t('identity.title')}</h2>
        <p className="text-sm text-mute">{t('identity.note')}</p>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t('identity.default')}</legend>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" role="radiogroup" aria-label={t('identity.default')}>
          {BRANDS.map((b) => {
            const on = v.brand === b;
            return (
              <label key={b} data-testid={`identity-card-${b}`} data-selected={on || undefined}
                className={`card flex cursor-pointer flex-col gap-2 p-3 ${on ? 'ring-2 ring-accent' : ''} ${ro ? 'cursor-default' : ''}`}>
                <BrandPreview brand={b} />
                <span className="flex items-center gap-2">
                  <input type="radio" name="identity-default" value={b} checked={on} disabled={ro} data-testid={`identity-default-${b}`}
                    onChange={() => setDraft({ ...v, brand: b })} />
                  <span className="font-semibold">{t(`brand.${b}`)}</span>
                  {b === cur.default_brand && <span className="chip bg-accentSoft text-accentText" data-testid={`identity-current-${b}`}>{t('identity.in_force')}</span>}
                </span>
                <span className="text-xs text-mute">{t(`brand.${b}_desc`)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-sm font-semibold">{t('identity.defaults_title')}</legend>
        <p className="mb-2 text-xs text-mute">{t('identity.defaults_note')}</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="identity-defaults">
          {(Object.keys(APPEARANCE_OPTIONS) as AppearanceKey[]).map((k) => (
            <label key={k} className="block text-sm font-semibold">{t(`appearance.dim.${k}`)}
              <select className="input mt-1 font-normal" data-testid={`identity-def-${k}`} disabled={ro}
                value={v.defaults[k] ?? ''} onChange={(e) => setDraft({ ...v, defaults: { ...v.defaults, [k]: e.target.value === '' ? undefined : e.target.value } })}>
                <option value="">{t('identity.defaults_builtin', { name: t(`appearance.opt.${k}.standard`) })}</option>
                {APPEARANCE_OPTIONS[k].map((opt) => <option key={opt} value={opt}>{t(`appearance.opt.${k}.${opt}`)}</option>)}
              </select>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" data-testid="identity-allow" checked={v.allow} disabled={ro} onChange={(e) => setDraft({ ...v, allow: e.target.checked })} />
        <span><span className="font-semibold">{t('identity.allow')}</span><span className="block text-xs text-mute">{t(v.allow ? 'identity.allow_on' : 'identity.allow_off')}</span></span>
      </label>
      <fieldset data-testid="identity-logo">
        <legend className="mb-1 text-sm font-semibold">{t('identity.logo_title')}</legend>
        <p className="mb-2 text-xs text-mute">{t('identity.logo_note')}</p>
        <div className="flex flex-wrap items-center gap-3">
          {cur.logo
            ? <img src={`${API_BASE}/ui/assets/logo?v=${cur.logo.version}`} alt={t('identity.logo_alt')} data-testid="identity-logo-preview" className="h-10 w-10 rounded-md border border-line object-contain" />
            : <span className="grid h-10 w-10 place-items-center rounded-md bg-accent text-accentInk" data-testid="identity-logo-badge">G</span>}
          <span className="text-sm text-mute" data-testid="identity-logo-state">
            {!cur.logo ? t('identity.logo_none') : cur.logo.enabled ? (cur.logo.updated_by && cur.logo.updated_at ? t('identity.logo_updated', { name: cur.logo.updated_by.display_name, when: fmtDateTime(cur.logo.updated_at, ar ? 'ar' : 'en') }) : '') : t('identity.logo_hidden')}
          </span>
          {!ro && (
            <>
              <label className="btn" data-testid="identity-logo-choose">
                {cur.logo ? t('identity.logo_replace') : t('identity.logo_upload')}
                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" data-testid="identity-logo-file"
                  onChange={(e) => { const f = e.target.files?.[0] ?? null; if (f) { logoFile.current = f; setLogoDialog('upload'); } e.target.value = ''; }} />
              </label>
              {cur.logo?.enabled && <button className="btn" data-testid="identity-logo-hide" onClick={() => setLogoDialog('hide')}>{t('identity.logo_hide')}</button>}
              {cur.logo && !cur.logo.enabled && <button className="btn" data-testid="identity-logo-show" onClick={() => setLogoDialog('show')}>{t('identity.logo_show')}</button>}
            </>
          )}
        </div>
      </fieldset>
      <div className="rounded-md bg-card2 p-3 text-sm" data-testid="identity-status-locked">
        <p className="mb-2 flex items-center gap-1 font-semibold"><Lock size={14} aria-hidden />{t('identity.status_locked')}</p>
        <div className="flex flex-wrap gap-2">
          <span className="chip bg-state-done-bg text-state-done-fg">{t('identity.st_done')}</span>
          <span className="chip bg-state-progress-bg text-state-progress-fg">{t('identity.st_progress')}</span>
          <span className="chip bg-state-late-bg text-state-late-fg">{t('identity.st_late')}</span>
          <span className="chip bg-state-locked-bg text-state-locked-fg">{t('identity.st_locked')}</span>
          <span className="chip bg-state-na-bg text-state-na-fg">{t('identity.st_na')}</span>
          <span className="chip bg-state-planned-bg text-state-planned-fg">{t('identity.st_planned')}</span>
        </div>
        <p className="mt-2 text-xs text-mute">{t('identity.status_locked_note')}</p>
      </div>
      <p className="text-xs text-mute" data-testid="identity-updated">
        {cur.updated_by && cur.updated_at
          ? t('identity.updated', { name: cur.updated_by.display_name, when: fmtDateTime(cur.updated_at, ar ? 'ar' : 'en') })
          : t('identity.never')}
      </p>
      {ro
        ? <p className="text-sm text-mute" data-testid="identity-readonly">{t('identity.readonly')}</p>
        : <button className="btn btn-accent" data-testid="identity-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="identity-dialog" title={t('identity.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, default_brand: v.brand, allow_user_choice: v.allow, defaults: v.defaults, reason },
            { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
          <p className="text-sm text-mute" data-testid="identity-confirm">
            {t('identity.confirm', { name: t(`brand.${v.brand}`), choice: t(v.allow ? 'identity.choice_on' : 'identity.choice_off') })}
          </p>
        </FormDialog>
      )}
      {logoDialog === 'upload' && (
        <FormDialog open onClose={() => setLogoDialog(null)} testid="identity-logo-dialog" title={t('identity.logo_title')} busy={putLogo.isPending} error={putLogo.isError ? errText(putLogo.error, t) : null}
          onSubmit={(reason) => { const f = logoFile.current; if (!f) return; putLogo.mutate({ file: f, reason, version: cur.logo?.version ?? null },
            { onSuccess: () => { toast(t('settings.audited')); setLogoDialog(null); logoFile.current = null; } }); }}>
          <p className="text-sm text-mute" data-testid="identity-logo-confirm-upload">{t('identity.logo_confirm_upload')}</p>
        </FormDialog>
      )}
      {(logoDialog === 'hide' || logoDialog === 'show') && cur.logo && (
        <FormDialog open onClose={() => setLogoDialog(null)} testid="identity-logo-dialog" title={t('identity.logo_title')} busy={setLogo.isPending} error={setLogo.isError ? errText(setLogo.error, t) : null}
          onSubmit={(reason) => setLogo.mutate({ version: cur.logo!.version, enabled: logoDialog === 'show', reason },
            { onSuccess: () => { toast(t('settings.audited')); setLogoDialog(null); } })}>
          <p className="text-sm text-mute" data-testid="identity-logo-confirm-toggle">{t(logoDialog === 'show' ? 'identity.logo_confirm_show' : 'identity.logo_confirm_hide')}</p>
        </FormDialog>
      )}
    </section>
  );
}
