import { Languages, Moon, ShieldCheck, Sun, Eye, EyeOff, Network, Radio, MapPinned, type LucideIcon } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { applyLocale, applyTheme, currentLocale, currentTheme } from '@/i18n';

/** The language and theme switches of the signed-out pages (same keys and functions as the signed-in shell). */
export function AuthToolbar() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState(currentTheme());
  const lang = currentLocale();
  return (
    <div className="flex items-center gap-2">
      <button type="button" className="btn gap-1" data-testid="auth-lang" onClick={() => applyLocale(lang === 'ar' ? 'en' : 'ar')} aria-label={t('auth.switch_lang')}>
        <Languages size={16} aria-hidden /> {lang === 'ar' ? 'English' : 'العربية'}
      </button>
      <button type="button" className="btn gap-1" data-testid="auth-theme" aria-pressed={theme === 'dark'} aria-label={t('auth.switch_theme')}
        onClick={() => { const n = theme === 'dark' ? 'light' : 'dark'; applyTheme(n); setTheme(n); }}>
        {theme === 'dark' ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
        <span className="hidden sm:inline">{theme === 'dark' ? t('auth.light') : t('auth.dark')}</span>
      </button>
    </div>
  );
}

const POINTS: { icon: LucideIcon; key: string }[] = [
  { icon: MapPinned, key: 'auth.brand.p1' },
  { icon: Network, key: 'auth.brand.p2' },
  { icon: Radio, key: 'auth.brand.p3' },
];

/** Split layout: a brand panel (hidden on small screens) and the form side. Logical CSS keeps it correct in RTL. */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" data-testid="auth-shell">
      <aside className="relative hidden overflow-hidden bg-accent p-10 text-accentInk lg:flex lg:flex-col lg:justify-between" aria-hidden>
        <div className="flex items-center gap-3 text-xl font-bold">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-white/15 text-lg">G</span>{t('app.name')}
        </div>
        <div className="space-y-6">
          <h2 className="text-3xl font-bold leading-tight">{t('auth.brand.title')}</h2>
          <ul className="space-y-4">
            {POINTS.map(({ icon: Icon, key }) => (
              <li key={key} className="flex items-start gap-3"><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white/15"><Icon size={18} /></span><span>{t(key)}</span></li>
            ))}
          </ul>
        </div>
        <p className="flex items-center gap-2 text-sm opacity-90"><ShieldCheck size={16} />{t('auth.brand.secure')}</p>
        <div className="pointer-events-none absolute -bottom-24 -end-24 h-72 w-72 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute -top-16 -end-10 h-40 w-40 rounded-full bg-white/10" />
      </aside>
      <main className="flex min-h-screen flex-col p-4 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-bold lg:invisible"><span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accentInk">G</span>{t('app.name')}</div>
          <AuthToolbar />
        </div>
        <div className="grid flex-1 place-items-center py-6">
          <div style={{ width: `min(${wide ? 520 : 440}px, 100%)` }}>{children}</div>
        </div>
        <footer className="text-center text-xs text-faint" data-testid="auth-footer">{t('auth.footer')}</footer>
      </main>
    </div>
  );
}

/** A password box with a show/hide button and a Caps Lock warning. The input keeps its test id and autocomplete. */
export function PasswordField({ id, label, value, onChange, testid, autoComplete, autoFocus, describedBy }: {
  id: string; label: string; value: string; onChange: (v: string) => void; testid: string; autoComplete: string; autoFocus?: boolean; describedBy?: string;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const watch = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') === true);
  return (
    <div>
      <label className="block text-sm font-semibold" htmlFor={id}>{label}</label>
      <div className="relative mt-1">
        <input id={id} data-testid={testid} type={shown ? 'text' : 'password'} className="input w-full pe-11" dir="ltr" autoComplete={autoComplete} autoFocus={autoFocus}
          value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={watch} onKeyUp={watch} onBlur={() => setCaps(false)} aria-describedby={caps ? `${id}-caps` : describedBy} />
        <button type="button" className="absolute inset-y-0 end-0 grid w-10 place-items-center text-mute hover:text-ink" data-testid={`${testid}-toggle`} aria-pressed={shown}
          aria-label={shown ? t('auth.hide_password') : t('auth.show_password')} onClick={() => setShown((s) => !s)}>
          {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </div>
      {caps && <p id={`${id}-caps`} role="status" className="mt-1 text-sm text-waitInk" data-testid={`${testid}-caps`}>{t('auth.caps_lock')}</p>}
    </div>
  );
}
