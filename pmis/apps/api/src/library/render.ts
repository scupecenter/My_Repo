/**
 * W5 (contract 0.15.69): the renderer of the Library forms. The same template language as the CW forms of design/forms (render.js, the "mini"
 * renderer): `{{path}}` (HTML-escaped), `{{{path}}}`, `{{#each list}}..{{else}}..{{/each}}`, `{{#if path}}..{{else}}..{{/if}}`, `{{this}}` and
 * dotted paths. There are no helpers and nothing is evaluated.
 *
 * Site data is always escaped: a raw `{{{x}}}` is raw only for the values the server builds itself (the CSS-safe copies the CW forms use in their
 * page margins); any other raw path is escaped as well, so a value typed into a site field can never become markup.
 */
const RAW_OK = new Set(['doc.qr_svg_uri', 'doc.ref_no_css', 'template.code_css', 'template.version_css']);

const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

type Ctx = Record<string, unknown>;

export function getPath(c: unknown, p: string): unknown {
  if (p === 'this') return c;
  return p.split('.').reduce<unknown>((o, k) => (o === null || o === undefined || typeof o !== 'object' ? undefined : (o as Record<string, unknown>)[k]), c);
}
const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : !!v);

export interface RenderResult {
  html: string;
  /** placeholders that had no value (shown to the user as a warning; never an error) */
  missing: string[];
}

export function renderForm(tpl: string, data: Ctx): RenderResult {
  const missing = new Set<string>();
  const block = (src: string, ctx: unknown): string => {
    let out = '';
    let i = 0;
    const re = /\{\{\{(.+?)\}\}\}|\{\{#(each|if) (.+?)\}\}|\{\{(.+?)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      out += src.slice(i, m.index);
      i = re.lastIndex;
      if (m[1] !== undefined) {
        const p = m[1].trim();
        const v = getPath(ctx, p);
        if (v === undefined || v === null || v === '') missing.add(p);
        out += RAW_OK.has(p) ? String(v ?? '') : esc(v ?? '');
      } else if (m[2] !== undefined) {
        // the matching close, honouring nesting
        let depth = 1;
        let j = src.length;
        let end = src.length;
        const sc = /\{\{(#(?:each|if)\b|\/(?:each|if))[^}]*\}\}/g;
        sc.lastIndex = i;
        let e: RegExpExecArray | null;
        while ((e = sc.exec(src))) {
          depth += (e[1] as string)[0] === '#' ? 1 : -1;
          if (!depth) {
            j = e.index;
            end = sc.lastIndex;
            break;
          }
        }
        const inner = src.slice(i, j);
        i = end;
        re.lastIndex = i;
        let a = inner;
        let b = '';
        let d = 0;
        const es = /\{\{(#(?:each|if)\b|\/(?:each|if)|else)[^}]*\}\}/g;
        let x: RegExpExecArray | null;
        while ((x = es.exec(inner))) {
          const tag = x[1] as string;
          if (tag[0] === '#') d++;
          else if (tag[0] === '/') d--;
          else if (!d) {
            a = inner.slice(0, x.index);
            b = inner.slice(es.lastIndex);
            break;
          }
        }
        const v = getPath(ctx, (m[3] as string).trim());
        if (m[2] === 'if') out += block(truthy(v) ? a : b, ctx);
        else
          out += Array.isArray(v) && v.length
            ? v.map((it) => block(a, it !== null && typeof it === 'object' ? { ...(ctx as Ctx), ...(it as Ctx) } : it)).join('')
            : block(b, ctx);
      } else {
        const p = (m[4] as string).trim();
        if (p === 'else' || p.startsWith('/')) continue; // a stray close tag is dropped
        const v = getPath(ctx, p);
        if (v === undefined || v === null || v === '') missing.add(p);
        out += esc(v ?? '');
      }
    }
    return out + src.slice(i);
  };
  return { html: block(tpl, data), missing: [...missing].sort() };
}

/** The data of a form plus its bindings (`fields.<name>` = the value at the bound path) and the CSS-safe copies the CW templates use in their page margins. */
export function formData(data: Ctx, bindings: Record<string, string> | null | undefined): Ctx {
  const d = JSON.parse(JSON.stringify(data)) as Ctx;
  const fields: Record<string, unknown> = {};
  for (const [k, path] of Object.entries(bindings ?? {})) fields[k] = getPath(d, path) ?? '';
  d.fields = fields;
  const cssEsc = (v: unknown) => String(v ?? '').replace(/[\\"<>&\n\r']/g, '');
  const doc = (d.doc ?? {}) as Ctx;
  const tplInfo = (d.template ?? {}) as Ctx;
  d.doc = { ...doc, ref_no_css: cssEsc(doc.ref_no), qr_svg_uri: '' };
  d.template = { ...tplInfo, code_css: cssEsc(tplInfo.code), version_css: String(Number.parseInt(String(tplInfo.version ?? '0'), 10) || 0) };
  return d;
}

/** The headers of a served form: no script, no network, no framing by others; the browser shows it as a document. */
export const FORM_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
