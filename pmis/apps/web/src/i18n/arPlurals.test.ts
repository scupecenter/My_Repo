import i18n from 'i18next';
import { describe, expect, it } from 'vitest';
import ar from './ar.json';
import en from './en.json';
import { withArabicPlurals } from './arPlurals';

describe('Arabic plural categories', () => {
  it('shows the Arabic text for 0, 1, 2, 5, 11 and 100 (no English fallback)', async () => {
    const i = i18n.createInstance();
    await i.init({ lng: 'ar', fallbackLng: 'en', resources: { en: { translation: en }, ar: { translation: withArabicPlurals(ar) } } });
    for (const n of [0, 1, 2, 3, 5, 10, 11, 99, 100]) expect(i.t('dailyPlan.reasons_missing', { count: n }), String(n)).toMatch(/[\u0600-\u06FF]/);
    expect(i.t('dailyPlan.reasons_missing', { count: 2 })).toBe('2 أسباب ناقصة');
  });
  it('keeps an explicit category', () => {
    const r = withArabicPlurals({ a_one: 'x', a_other: 'y', a_two: 'z' });
    expect(r.a_two).toBe('z'); expect((r as Record<string, string>).a_few).toBe('y');
  });
  it('every Arabic plural key resolves in Arabic for every count (whole catalogue)', async () => {
    const i = i18n.createInstance();
    await i.init({ lng: 'ar', fallbackLng: false as never, resources: { ar: { translation: withArabicPlurals(ar) } } });
    const keys: string[] = [];
    const walk = (o: Record<string, unknown>, p: string) => { for (const [k, v] of Object.entries(o)) { if (typeof v === 'object' && v) walk(v as Record<string, unknown>, `${p}${k}.`); else if (k.endsWith('_other') && (o as Record<string, unknown>)[`${k.slice(0, -6)}_one`] !== undefined) keys.push(`${p}${k.slice(0, -6)}`); } };
    walk(ar as Record<string, unknown>, '');
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) for (const n of [0, 1, 2, 4, 12]) expect(i.t(k, { count: n }), `${k} ${n}`).not.toBe(k);
  });
});
