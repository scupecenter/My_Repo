import { useEffect } from 'react';
import { API_BASE } from '@/api/client';
import { useUiPublicIdentity } from '@/api/settings';

/** The URL of the public logo image for a purpose, versioned so a new upload is fetched at once. */
export const publicLogoUrl = (purpose: 'login' | 'favicon', version: number) => `${API_BASE}/ui/public/logo/${purpose}?v=${version}`;

/**
 * The company logo on the signed-out pages (0243, admin switch "show on the sign-in pages", OFF by default). Renders nothing while it is off, so
 * the built-in badge (`fallback`) stays exactly as before.
 */
export function LoginLogo({ className, fallback }: { className: string; fallback: JSX.Element }) {
  const q = useUiPublicIdentity();
  const l = q.data?.login ?? null;
  if (!l) return fallback;
  return <img src={publicLogoUrl('login', l.version)} alt="" data-testid="auth-logo" className={className} />;
}

/** Keeps the browser tab icon on the logo while the admin switch "use as tab icon" is on (OFF by default); removes it when switched off. */
export function FaviconSync() {
  const q = useUiPublicIdentity();
  const f = q.data?.favicon ?? null;
  const url = f ? publicLogoUrl('favicon', f.version) : null;
  const mime = f?.mime ?? null;
  useEffect(() => {
    const ID = 'pmis-logo-favicon';
    const old = document.getElementById(ID);
    if (!url) { old?.remove(); return; }
    const link = (old as HTMLLinkElement | null) ?? document.createElement('link');
    link.id = ID; link.rel = 'icon'; link.href = url; if (mime) link.type = mime;
    if (!old) document.head.appendChild(link);
  }, [url, mime]);
  return null;
}
