import { Languages, Moon, ShieldCheck, Sun, Eye, EyeOff, Network, Radio, MapPinned, Info, Wrench, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLoginPagePublic } from '@/api/settings';
import { LoginLogo } from './PublicLogo';
import { applyLocale, applyTheme, currentLocale, currentTheme } from '@/i18n';

/** The language and theme switches of the signed-out pages (same keys and functions as the signed-in shell). */
export function AuthToolbar() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState(currentTheme());
  const lang = currentLocale();
  // 0658: the admin may hide either switch (render only); both show until the settings load.
  const cfg = useLoginPagePublic().data;
  const showLang = cfg?.show_language_switch ?? true, showTheme = cfg?.show_theme_switch ?? true;
  return (
    <div className="flex items-center gap-2">
      {showLang && <button type="button" className="btn gap-1" data-testid="auth-lang" onClick={() => applyLocale(lang === 'ar' ? 'en' : 'ar')} aria-label={`${t('auth.switch_lang')}: ${lang === 'ar' ? 'English' : 'العربية'}`}>
        <Languages size={16} aria-hidden /> {lang === 'ar' ? 'English' : 'العربية'}
      </button>}
      {showTheme && <button type="button" className="btn gap-1" data-testid="auth-theme" aria-pressed={theme === 'dark'} aria-label={`${t('auth.switch_theme')}: ${theme === 'dark' ? t('auth.light') : t('auth.dark')}`}
        onClick={() => { const n = theme === 'dark' ? 'light' : 'dark'; applyTheme(n); setTheme(n); }}>
        {theme === 'dark' ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
        <span className="hidden sm:inline">{theme === 'dark' ? t('auth.light') : t('auth.dark')}</span>
      </button>}
    </div>
  );
}

const POINTS: { icon: LucideIcon; key: string }[] = [
  { icon: MapPinned, key: 'auth.brand.p1' },
  { icon: Network, key: 'auth.brand.p2' },
  { icon: Radio, key: 'auth.brand.p3' },
];

/** A small telecom network (nodes, links and tower waves) drawn behind the signed-out pages. Decorative only (aria-hidden). */
function NetworkArt({ className = '' }: { className?: string }) {
  const nodes: [number, number][] = [[90, 110], [230, 70], [380, 140], [560, 80], [710, 150], [150, 300], [330, 260], [520, 320], [690, 280], [240, 470], [450, 500], [640, 450]];
  const links: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 2], [6, 7], [7, 8], [7, 4], [5, 9], [9, 10], [10, 6], [10, 11], [11, 8]];
  return (
    <svg className={className} viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false">
      {links.map(([a, b], i) => <line key={i} className="link" x1={nodes[a]![0]} y1={nodes[a]![1]} x2={nodes[b]![0]} y2={nodes[b]![1]} />)}
      <path className="wave" d="M382 118a26 26 0 0 1 0 22 M370 106a46 46 0 0 1 0 46 M358 94a66 66 0 0 1 0 70" transform="translate(0,-2)" />
      <path className="wave" d="M692 258a26 26 0 0 1 0 22 M680 246a46 46 0 0 1 0 46" />
      {nodes.map(([x, y], i) => (i % 4 === 0
        ? <circle key={i} className="node pulse" cx={x} cy={y} r="7" style={i % 8 === 0 ? { animationDelay: '2.2s' } : undefined} />
        : <circle key={i} className="node" cx={x} cy={y} r="4.5" />))}
      <circle className="hub pulse" cx="380" cy="140" r="4" />
      <circle className="hub" cx="690" cy="280" r="4" />
    </svg>
  );
}

/** The calm animated backdrop of the signed-out pages (0197): two soft glows and the network art. No motion when the admin turned it off or the visitor prefers reduced motion. */
function AuthBackdrop() {
  return (
    <div className="auth-backdrop" aria-hidden>
      <div className="glow glow-a" />
      <div className="glow glow-b" />
      <NetworkArt />
    </div>
  );
}

/** The admin announcement of the sign-in page (Settings > Screens > Login page); nothing renders while none is set. */
function AuthAnnouncement() {
  const { t, i18n } = useTranslation();
  const cfg = useLoginPagePublic();
  const ann = cfg.data?.announcement ?? null;
  if (!ann) return null;
  const ar = i18n.language === 'ar';
  const text = (ar ? ann.ar || ann.en : ann.en || ann.ar).trim();
  if (!text) return null;
  const Icon = ann.kind === 'maintenance' ? Wrench : Info;
  return (
    <p role="status" data-testid="auth-announcement" data-kind={ann.kind}
      className={`auth-enter mb-4 flex items-start gap-2 rounded-md border p-3 text-sm ${ann.kind === 'maintenance' ? 'border-waitInk/30 bg-waitBg text-waitInk' : 'border-accent/30 bg-accentSoft text-accentText'}`}>
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span><span className="sr-only">{t('auth.announcement')}: </span>{text}</span>
    </p>
  );
}

/** Under the form: a generic availability dot (no backend detail) and the admin support links (0197). */
function AuthFooter() {
  const { t, i18n } = useTranslation();
  const cfg = useLoginPagePublic();
  const state = cfg.isSuccess ? 'available' : cfg.isError ? 'unavailable' : 'checking';
  const links = cfg.data?.support_links ?? [];
  const ar = i18n.language === 'ar';
  return (
    <footer className="space-y-2 text-center text-xs text-faint">
      <p className="flex items-center justify-center gap-2" data-testid="auth-status" data-state={state}>
        <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${state === 'available' ? 'bg-done' : state === 'unavailable' ? 'bg-late' : 'bg-mute animate-pulse motion-reduce:animate-none'}`} />
        {t(`auth.status_${state}`)}
      </p>
      {links.length > 0 && (
        <nav aria-label={t('auth.support')} className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1" data-testid="auth-support">
          {links.map((l, i) => (
            <a key={i} data-testid={`auth-support-${i}`} href={l.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-link hover:underline">
              {(ar ? l.label_ar || l.label_en : l.label_en) || l.url}
            </a>
          ))}
        </nav>
      )}
      <p data-testid="auth-footer">{t('auth.footer')}</p>
    </footer>
  );
}

/** Split layout: a brand panel (hidden on small screens) and the form side. Logical CSS keeps it correct in RTL. */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { t } = useTranslation();
  const cfg = useLoginPagePublic();
  const anim = cfg.data?.animation ?? true;
  // The admin default language of the signed-out pages (0197) applies only until the visitor picks one.
  useEffect(() => {
    const d = cfg.data?.default_locale;
    if (d && !localStorage.getItem('pmis.locale')) applyLocale(d);
  }, [cfg.data?.default_locale]);
  return (
    <div className="auth-shell relative grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" data-testid="auth-shell" data-anim={anim ? '1' : '0'}>
      <aside className="relative hidden overflow-hidden bg-accent p-10 text-accentInk lg:flex lg:flex-col lg:justify-between" aria-hidden>
        <div className="auth-brand-art pointer-events-none absolute inset-0" aria-hidden><NetworkArt className="h-full w-full" /></div>
        <div className="auth-enter relative flex items-center gap-3 text-xl font-bold">
          <LoginLogo className="h-10 w-10 rounded-lg bg-white/15 object-contain p-0.5" fallback={<span className="grid h-10 w-10 place-items-center rounded-lg bg-white/15 text-lg">G</span>} />{t('app.name')}
        </div>
        <div className="relative space-y-6">
          <h2 className="auth-enter auth-enter-d1 text-3xl font-bold leading-tight">{t('auth.brand.title')}</h2>
          <ul className="space-y-4">
            {POINTS.map(({ icon: Icon, key }) => (
              <li key={key} className="auth-enter auth-enter-d2 flex items-start gap-3"><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white/15"><Icon size={18} /></span><span>{t(key)}</span></li>
            ))}
          </ul>
        </div>
        <p className="auth-enter auth-enter-d2 relative flex items-center gap-2 text-sm opacity-90"><ShieldCheck size={16} />{t('auth.brand.secure')}</p>
        <div className="pointer-events-none absolute -bottom-24 -end-24 h-72 w-72 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute -top-16 -end-10 h-40 w-40 rounded-full bg-white/10" />
      </aside>
      <main className="relative flex min-h-screen flex-col p-4 sm:p-6">
        <AuthBackdrop />
        <div className="relative flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-bold lg:invisible"><LoginLogo className="h-8 w-8 rounded-md object-contain" fallback={<span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accentInk">G</span>} />{t('app.name')}</div>
          <AuthToolbar />
        </div>
        <div className="relative grid flex-1 place-items-center py-6">
          <div style={{ width: `min(${wide ? 520 : 440}px, 100%)` }}>
            <AuthAnnouncement />
            {children}
          </div>
        </div>
        <AuthFooter />
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
