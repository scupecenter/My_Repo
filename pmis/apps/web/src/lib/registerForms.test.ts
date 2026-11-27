import { describe, expect, it } from 'vitest';
import type { RegisterDefinition, RegisterField } from '@/api/types';
import { sectionsFor } from './registerForms';

const field = (code: string, section: string | null, section_ar?: string | null): RegisterField =>
  ({ code, label_en: code, label_ar: null, type: 'text', required: false, read_only: false, in_list: false, is_custom: false, ...(section ? { section } : {}), ...(section_ar ? { section_ar } : {}) }) as RegisterField;

const def = (fields: RegisterField[]): RegisterDefinition =>
  ({ register_key: 'permits_hse', name_en: 'Permits', name_ar: null, fields }) as unknown as RegisterDefinition;

describe('sectionsFor Arabic section titles (0422)', () => {
  it('carries section_ar as title_ar and keeps the id from the English name', () => {
    const s = sectionsFor(def([field('a', 'PTW checks', 'فحوصات تصريح العمل'), field('b', 'PTW checks', 'فحوصات تصريح العمل')]), {});
    expect(s).toHaveLength(1);
    expect(s[0].id).toBe('ptw');
    expect(s[0].title).toBe('PTW checks');
    expect(s[0].title_ar).toBe('فحوصات تصريح العمل');
    expect(s[0].fields.map((f) => f.code)).toEqual(['a', 'b']);
  });
  it('leaves title_ar unset when the server sends none (renderers fall back to English)', () => {
    const s = sectionsFor(def([field('a', 'Validity')]), {});
    expect(s[0].title).toBe('Validity');
    expect(s[0].title_ar).toBeUndefined();
  });
  it('fields without a section stay in details with no title_ar', () => {
    const s = sectionsFor(def([field('a', null)]), {});
    expect(s[0].id).toBe('details');
    expect(s[0].title_ar).toBeUndefined();
  });
});
