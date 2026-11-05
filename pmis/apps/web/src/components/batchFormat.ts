import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useListCatalogues } from '@/api/lists';
import { useRegions } from '@/api/sites';
import type { RegisterDefinition } from '@/api/types';
import { showValue } from './RegisterFields';

export type Shown = { text: string; raw: string | null };
export type ShowValue = (code: string, v: unknown) => Shown;

const FLAG = /^(yes|no|na|n\/a)$/i;

/**
 * How a value of the "Changes" column is shown: the label in the current language, never the raw code. The code stays available as `raw` (a title).
 * Regions come from the regions list, scope flags from the flag keys, the delivery scenario from `scenario.*`, other lists from their catalogue label,
 * and the fields of a register from its definition.
 */
export function useBatchValueFormat(def: RegisterDefinition | undefined): ShowValue {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const regions = useRegions().data;
  const catalogues = useListCatalogues(true).data;
  return useCallback<ShowValue>((code, v) => {
    if (v === null || v === undefined || v === '') return { text: '—', raw: null };
    const raw = String(v);
    const label = (text: string): Shown => ({ text, raw: text === raw ? null : raw });
    const f = def?.fields.find((x) => x.code === code);
    if (f) return label(showValue(f, v, lang, t));
    if (code === 'region_id' || code === 'region') {
      const r = regions?.find((x) => String(x.id) === raw || x.code.toLowerCase() === raw.toLowerCase() || x.name_en.toLowerCase() === raw.toLowerCase());
      if (r) return label((lang === 'ar' && r.name_ar) || r.name_en);
    }
    if (code.startsWith('scope_') && FLAG.test(raw)) {
      const k = raw.toLowerCase();
      return label(k === 'yes' ? t('common.yes') : k === 'no' ? t('common.no') : t('scope.na'));
    }
    if (typeof v === 'boolean') return label(v ? t('common.yes') : t('common.no'));
    if (code === 'delivery_scenario') return label(t(`scenario.${raw}`, { defaultValue: raw }));
    if (code === 'overall_status') return label(t(`status.${raw}`, { defaultValue: raw }));
    const cat = catalogues?.find((c) => c.code === code || c.used_by.some((u) => u.field_code === code));
    const val = cat?.values.find((x) => x.code === raw || x.aliases.includes(raw));
    if (val) return label((lang === 'ar' && val.label_ar) || val.label_en);
    return { text: raw, raw: null };
  }, [def, lang, t, regions, catalogues]);
}
