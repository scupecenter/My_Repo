import type { TFunction } from 'i18next';
import type { Stream, StreamStatus } from '@/api/types';

/**
 * Default streams (CLAUDE.md "Site Register and streams"). The API sends the real list in `streams[]`; this one only
 * keeps the sub-section tabs on screen before the first answer or when the caller sees no site.
 */
export const DEFAULT_STREAMS: Stream[] = [
  { code: 'DESIGN_ACQ', name_en: 'Design & Acquisition', name_ar: 'التصميم والاستحواذ', sort_order: 1 },
  { code: 'CW', name_en: 'Civil Works', name_ar: 'الأعمال المدنية', sort_order: 2 },
  { code: 'TE', name_en: 'Installation (TE)', name_ar: 'التركيبات', sort_order: 3 },
  { code: 'CLOSURE', name_en: 'Handover & Closure', name_ar: 'التسليم والإغلاق', sort_order: 4 },
];

/**
 * Owner decision Q41: Dismantle is a fifth sub-section outside the stage mapping.
 * TODO(tech-lead): the API (migration 0015) has no DISMANTLE stream and no Dismantle tasks yet. The tab is shown, but it
 * lists nothing and calls nothing until `streams[]` carries a DISMANTLE entry. No data is made up for it.
 */
export const DISMANTLE_CODE = 'DISMANTLE';
const DISMANTLE: Stream = { code: DISMANTLE_CODE, name_en: 'Dismantle', name_ar: 'الفك', sort_order: 99 };

/** The tabs: the API streams in order, then Dismantle unless the API already has it. */
export function withDismantle(streams: Stream[] | undefined): Stream[] {
  const base = streams?.length ? [...streams].sort((a, b) => a.sort_order - b.sort_order) : DEFAULT_STREAMS;
  return base.some((s) => s.code === DISMANTLE_CODE) ? base : [...base, DISMANTLE];
}

/** Stream name in the UI language; the locale file wins so that the agreed Arabic names show, the API name is the fallback. */
export function streamName(t: TFunction, lang: string, s: Pick<Stream, 'code' | 'name_en' | 'name_ar'>): string {
  return t(`stream.${s.code}`, { defaultValue: (lang === 'ar' && s.name_ar) || s.name_en });
}

export const statusOf = (streams: StreamStatus[] | undefined, code: string) => streams?.find((s) => s.code === code);

/** A stream that the API does not know yet (Dismantle) has nothing to fetch. */
export const isRealStream = (code: string, streams: Stream[] | undefined) => code !== DISMANTLE_CODE || !!streams?.some((s) => s.code === code);
