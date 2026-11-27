import i18n from 'i18next';
import { describe, expect, it } from 'vitest';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { notificationTitle } from './notificationTitle';

const t = i18n.getFixedT('ar') as never;
describe('notificationTitle (inbox titles in the user language)', () => {
  it('keeps the stored text in English', () => {
    expect(notificationTitle('You were mentioned', 'en', t)).toBe('You were mentioned');
  });
  it('maps the known titles in Arabic, with the name or code kept', async () => {
    await i18n.init({ lng: 'ar', resources: { ar: { translation: ar }, en: { translation: en } } });
    expect(notificationTitle('You were mentioned', 'ar', i18n.t as never)).toBe('تمت الإشارة إليك');
    expect(notificationTitle('A followed site changed', 'ar', i18n.t as never)).toBe('تغيّر موقع تتابعه');
    expect(notificationTitle('WM105 D14 waits for your approval', 'ar', i18n.t as never)).toBe('WM105 D14 بانتظار اعتمادك');
    expect(notificationTitle('ZW310 B6 was returned with a note', 'ar', i18n.t as never)).toBe('أُعيد ZW310 B6 مع ملاحظة');
    expect(notificationTitle('Absence recorded: Sara', 'ar', i18n.t as never)).toBe('سُجّل غياب: Sara');
  });
  it('shows an unknown title as stored (it is data)', () => {
    expect(notificationTitle('Something new', 'ar', i18n.t as never)).toBe('Something new');
  });
  it('has an Arabic string for every English title key', () => {
    const e = Object.keys(en.inbox).filter((k) => k.startsWith('t_') || k.startsWith('p_'));
    for (const k of e) expect((ar.inbox as Record<string, string>)[k], k).toBeTruthy();
  });
});
