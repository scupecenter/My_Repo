import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { useRegisterDefs, useRegisterRecord } from '@/api/registers';
import { useSite } from '@/api/sites';
import { composeTitle, pageLabelKey, PRODUCT_KEY, titleRoute } from '@/lib/pageTitle';

/**
 * Keeps the browser tab title in step with the screen: "<page> | <product>", a record or site adds its code
 * ("PR 123 · Procurement | ..."), in the language of the screen. Renders nothing. Reads the same cached queries as the screens.
 */
export function PageTitle() {
  const { t, i18n } = useTranslation();
  const { pathname, search } = useLocation();
  const route = titleRoute(pathname, search);
  const defs = useRegisterDefs();
  const record = useRegisterRecord(route.kind === 'record' ? route.key! : '', route.kind === 'record' ? route.id! : null);
  const site = useSite(route.kind === 'site' ? route.id! : '');
  const ar = i18n.language === 'ar';
  const def = route.key ? defs.data?.find((d) => d.register_key === route.key) : undefined;
  const regName = def ? ((ar && def.name_ar) || def.name_en) : '';
  let head: string | null = null;
  if (route.kind === 'register') head = regName || null;
  else if (route.kind === 'record') {
    const code = record.data?.site_code ?? '';
    head = [code, regName].filter(Boolean).join(' · ') || regName || null;
  } else if (route.kind === 'site') {
    const s = site.data;
    head = s ? [s.site_code, s.name].filter(Boolean).join(' · ') : null;
  } else {
    const k = pageLabelKey(pathname);
    head = k ? t(k) : null;
  }
  const title = composeTitle(head, t(PRODUCT_KEY));
  useEffect(() => { document.title = title; }, [title]);
  return null;
}
