import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import { viewer } from './db';
import { guard, problem } from './handlers';

/** Contract 0.15.331: the supplier companies of the invoice picker (0407) and the editable register rules, as register_rule_catalogue, reg_rules_json and admin_register_rules decide them. Synthetic. */
const CATALOGUE = [
  { register_key: 'invoices', key: 'currency', type: 'text', default: 'LYD', label_en: 'Invoice currency', label_ar: 'عملة الفواتير' },
  { register_key: 'invoices', key: 'order_required', type: 'boolean', default: false, label_en: 'An invoice must name its Procurement order', label_ar: 'الفاتورة يجب أن تحدد أمر المشتريات' },
  { register_key: 'invoices', key: 'supplier_required', type: 'boolean', default: false, label_en: 'An invoice must name its supplier company', label_ar: 'المورّد يجب أن يكون شركة في سجل المقاولين' },
] as const;
const RULES: Record<string, { rules: Record<string, unknown>; version: number }> = { invoices: { rules: { currency: 'LYD', order_required: false, supplier_required: false }, version: 1 } };
const isAdmin = () => viewer()?.key === 'pm';
const forbidden = () => problem(403, 'action_forbidden', 'You are not allowed to do this.');

export const resetRegisterRules = () => { RULES.invoices = { rules: { currency: 'LYD', order_required: false, supplier_required: false }, version: 1 }; };

export const registerRulesHandlers = [
  http.get(`${B}/registers/invoices/supplier-options`, () => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ items: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Aljeel Contracting', type: 'cw_contractor' }] });
  }),
  http.get(`${B}/settings/register-rules`, () => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    return HttpResponse.json({ catalogue: CATALOGUE, items: [{ register_key: 'invoices', name_en: 'Invoices', name_ar: 'الفواتير', ...RULES.invoices }] });
  }),
  http.put(`${B}/settings/register-rules/:key`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    const s = RULES[String(params.key)];
    if (!s) return problem(404, 'not_found', 'The register does not exist.');
    const b = (await request.json()) as { rules?: Record<string, unknown>; reason?: string };
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    for (const [k, v] of Object.entries(b.rules ?? {})) {
      const spec = CATALOGUE.find((c) => c.register_key === params.key && c.key === k);
      if (!spec) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: `/rules/${k}`, code: 'unknown_rule' }] });
      if (typeof v !== (spec.type === 'boolean' ? 'boolean' : 'string')) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: `/rules/${k}`, code: 'invalid' }] });
    }
    s.rules = { ...s.rules, ...b.rules };
    s.version += 1;
    return HttpResponse.json({ register_key: params.key, rules: s.rules, version: s.version }, { headers: { ETag: `"${s.version}"` } });
  }),
];
