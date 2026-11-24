/**
 * W5 (contract 0.15.70): the HTML allow-list of the Library forms. A form is printable HTML only: no script, no frame, no link, no form control that
 * submits, no network. The sanitizer does not patch the input; it re-serializes it. It reads the text into tokens (text, comments, declarations,
 * tags with their attributes) and writes a new document from the tokens it allows only: an allowed tag with its allowed attributes, each value
 * decoded and re-escaped by this code, text with `<` escaped. Whatever it cannot read as a well-formed tag is written as escaped text, so a
 * browser can never read markup that this code did not write (no parser differential: `<svg/onload=..>`, `java&#115;cript:`, `srcdoc`, `data:`
 * URLs, CSS `url()` and `@import` are all outside the list).
 *
 * Two uses: `checkTemplate` before a template is saved (the placeholders are neutralised first, and anything removed refuses the template with the
 * list), and `sanitizeHtml` on every rendered form (preview, generation), which keeps only what is allowed. The database repeats a deny-list on
 * save as defence in depth, the served file carries a CSP without scripts or network, and the web shows a preview only in a sandboxed frame.
 */

const ALLOWED_TAGS = new Set([
  'html', 'head', 'body', 'title', 'meta', 'style', 'div', 'span', 'p', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'mark',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'img', 'section', 'header', 'footer', 'main', 'article', 'figure', 'figcaption', 'blockquote', 'pre', 'code', 'label', 'input', 'center',
]);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'col']);
/** Their content is never kept: it is code or a nested document. */
const DROP_WITH_CONTENT = new Set(['script', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'xmp', 'noembed', 'noframes', 'frameset',
  'frame', 'applet', 'svg', 'math', 'plaintext', 'select', 'button', 'audio', 'video', 'canvas', 'portal']);
const GLOBAL_ATTRS = new Set(['class', 'id', 'style', 'dir', 'lang', 'title', 'align', 'valign', 'width', 'height']);
const TAG_ATTRS: Record<string, Set<string>> = {
  td: new Set(['colspan', 'rowspan', 'border']), th: new Set(['colspan', 'rowspan', 'scope', 'border']), table: new Set(['border', 'cellpadding', 'cellspacing']),
  col: new Set(['span']), colgroup: new Set(['span']), img: new Set(['src', 'alt']), input: new Set(['type', 'checked', 'disabled', 'value', 'name']),
  meta: new Set(['charset', 'name', 'content']), style: new Set(['media']), ol: new Set(['start', 'type']), label: new Set(['for']),
};
const INPUT_TYPES = new Set(['checkbox', 'radio', 'text']);
const IMG_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;
const CSS_DATA = /^data:(font\/[a-z0-9.+-]+|application\/(x-)?font-[a-z0-9.+-]+|application\/font-woff2?|image\/(png|jpe?g|gif|webp));base64,[A-Za-z0-9+/=]+$/i;
/** The neutral stand-in of a placeholder while a template is checked (a value the render fills later). */
export const PLACEHOLDER_TOKEN = 'w5plh';

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')' };

/** Character references decoded the way a browser does in an attribute value (numeric, hex and the common names), so a check sees the real value. */
function decodeEntities(v: string): string {
  return v.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    const k = e.toLowerCase();
    return k in NAMED ? (NAMED[k] as string) : m;
  });
}
const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Text: `<` and `>` escaped; a `&` that does not start a character reference becomes `&amp;`. */
const escText = (t: string) => t.replace(/&(?!(#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// eslint-disable-next-line no-control-regex
const squash = (v: string) => v.replace(/[\u0000-\u0020\u007f-\u00a0\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '');

export interface SanitizeResult {
  html: string;
  /** what was removed (a tag, an attribute, a CSS construct), in reading order; empty = the input was within the list */
  removed: string[];
}

/** CSS of a style element or attribute: no comments, no `<`, no escapes, no @import, no expression or binding, url() only to embedded fonts and images. */
export function sanitizeCss(css: string, removed: string[], template = false): string {
  // the marker of a kept url() (below) never comes from the input
  let out = css.replace(/\u0001/g, '').replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
  if (out.includes('\\')) { removed.push('css: escape'); out = out.replace(/\\/g, ''); }
  if (out.includes('<')) { removed.push('css: <'); out = out.replace(/</g, ''); }
  out = out.replace(/@import[^;]*;?/gi, () => { removed.push('css: @import'); return ''; });
  out = out.replace(/(expression\s*\(|behaviou?r\s*:|-moz-binding|javascript\s*:|vbscript\s*:)/gi, (m) => { removed.push(`css: ${m.toLowerCase().replace(/\s/g, '')}`); return ''; });
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_m, _q: string, inner: string) => {
    const v = squash(inner);
    if (CSS_DATA.test(v) || (template && v === PLACEHOLDER_TOKEN)) return `\u0001("${v}")`;
    removed.push('css: url()');
    return 'none';
  });
  // a url( that the pattern above did not read (an unbalanced quote or parenthesis) is never kept
  out = out.replace(/url\s*\(/gi, () => { removed.push('css: url()'); return 'none('; });
  out = out.replace(/(image-set|src)\s*\(/gi, (m) => { removed.push(`css: ${m.toLowerCase()}`); return 'none('; });
  // the url() kept above carry a marker until here, so the second pass does not meet them
  return out.replace(/\u0001\(/g, 'url(');
}

interface Attr { name: string; value: string | null }

/** Reads one tag at `i` (which holds `<`). Null when it is not a well-formed tag: the `<` is then text. */
function readTag(s: string, i: number): { end: number; close: boolean; name: string; attrs: Attr[]; selfClose: boolean } | null {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(s.slice(i, i + 40));
  if (!m) return null;
  let j = i + m[0].length;
  const attrs: Attr[] = [];
  let selfClose = false;
  for (;;) {
    while (j < s.length && /[\s/]/.test(s[j] as string)) { if (s[j] === '/') selfClose = true; j++; }
    if (j >= s.length) return null;
    if (s[j] === '>') { j++; break; }
    selfClose = false;
    const n = /^[^\s/>]+?(?==|[\s/>]|$)/.exec(s.slice(j, j + 200));
    if (!n || !n[0]) return null;
    const name = n[0];
    j += name.length;
    while (j < s.length && /\s/.test(s[j] as string)) j++;
    let value: string | null = null;
    if (s[j] === '=') {
      j++;
      while (j < s.length && /\s/.test(s[j] as string)) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const k = s.indexOf(q, j + 1);
        if (k < 0) return null;
        value = s.slice(j + 1, k);
        j = k + 1;
      } else {
        const u = /^[^\s>]*/.exec(s.slice(j)) as RegExpExecArray;
        value = u[0];
        j += value.length;
      }
    }
    attrs.push({ name, value });
  }
  return { end: j, close: m[1] === '/', name: (m[2] as string).toLowerCase(), attrs, selfClose };
}

function attrsOut(tag: string, attrs: Attr[], removed: string[], template: boolean): string {
  const allowed = TAG_ATTRS[tag];
  const out: string[] = [];
  const seen = new Set<string>();
  const metaName = attrs.find((a) => a.name.toLowerCase() === 'name')?.value?.toLowerCase();
  for (const a of attrs) {
    const name = a.name.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !(GLOBAL_ATTRS.has(name) || allowed?.has(name))) { removed.push(`${tag}@${name}`); continue; }
    const raw = a.value === null ? null : decodeEntities(a.value);
    if (name === 'checked' || name === 'disabled') { out.push(` ${name}`); continue; }
    let v = raw ?? '';
    if (name === 'style') v = sanitizeCss(v, removed, template);
    else if (name === 'src') {
      const sq = squash(v);
      if (!(IMG_DATA.test(sq) || (template && sq === PLACEHOLDER_TOKEN))) { removed.push(`${tag}@src`); continue; }
      v = sq;
    } else if (tag === 'input' && name === 'type') {
      if (!INPUT_TYPES.has(v.toLowerCase())) { removed.push(`input@type=${v.toLowerCase()}`); continue; }
    } else if (tag === 'meta') {
      if (name === 'charset' && v.toLowerCase() !== 'utf-8') { removed.push('meta@charset'); continue; }
      if (name === 'name' && v.toLowerCase() !== 'viewport') { removed.push('meta@name'); continue; }
      if (name === 'content' && (metaName !== 'viewport' || !/^[\w\s=,.-]*$/.test(v))) { removed.push('meta@content'); continue; }
    } else if (/^(javascript|vbscript|data):/i.test(squash(v))) { removed.push(`${tag}@${name}`); continue; }
    out.push(` ${name}="${escAttr(v)}"`);
  }
  return out.join('');
}

/** The allow-listed copy of a document (see the file comment). */
export function sanitizeHtml(input: string, opts: { template?: boolean } = {}): SanitizeResult {
  const s = input;
  const removed: string[] = [];
  const template = opts.template === true;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += escText(s.slice(i)); break; }
    out += escText(s.slice(i, lt));
    i = lt;
    if (s.startsWith('<!--', i)) {
      // as a browser reads it: "<!-->" and "<!--->" are empty comments, and "--!>" closes one too
      if (s.startsWith('<!-->', i)) { i += 5; continue; }
      if (s.startsWith('<!--->', i)) { i += 6; continue; }
      const a = s.indexOf('-->', i + 4);
      const b = s.indexOf('--!>', i + 4);
      const k = a < 0 ? b : b < 0 ? a : Math.min(a, b);
      i = k < 0 ? s.length : k + (k === b ? 4 : 3);
      continue;
    }
    if (/^<!doctype\s+html\s*>/i.test(s.slice(i, i + 30))) {
      out += '<!DOCTYPE html>';
      i = s.indexOf('>', i) + 1;
      continue;
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') {
      removed.push('declaration');
      const k = s.indexOf('>', i);
      i = k < 0 ? s.length : k + 1;
      continue;
    }
    const t = readTag(s, i);
    if (!t) { out += '&lt;'; i += 1; continue; }
    i = t.end;
    if (DROP_WITH_CONTENT.has(t.name)) {
      removed.push(`<${t.name}>`);
      if (!t.close && !t.selfClose) {
        const re = new RegExp(`</${t.name}\\s*>`, 'ig');
        re.lastIndex = i;
        const m = re.exec(s);
        i = m ? m.index + m[0].length : s.length;
      }
      continue;
    }
    if (t.name === 'style' || t.name === 'title') {
      if (t.close) continue;
      const re = new RegExp(`</${t.name}\\s*>`, 'ig');
      re.lastIndex = i;
      const m = re.exec(s);
      const body = s.slice(i, m ? m.index : s.length);
      i = m ? m.index + m[0].length : s.length;
      const okAttr = (a: Attr) => a.name.toLowerCase() === 'id' ? /^[A-Za-z][\w-]{0,60}$/.test(a.value ?? '') : t.name === 'style' && a.name.toLowerCase() === 'media' && /^(print|screen|all)$/i.test(a.value ?? '');
      if (t.attrs.some((a) => !okAttr(a))) removed.push(`${t.name}@attributes`);
      const keep = t.attrs.filter(okAttr).map((a) => ` ${a.name.toLowerCase()}="${escAttr(a.value ?? '')}"`).join('');
      out += t.name === 'style' ? `<style${keep}>${sanitizeCss(body, removed, template)}</style>` : `<title${keep}>${escText(decodeEntities(body))}</title>`;
      continue;
    }
    if (!ALLOWED_TAGS.has(t.name)) { removed.push(`<${t.name}>`); continue; }
    if (t.close) { if (!VOID.has(t.name)) out += `</${t.name}>`; continue; }
    out += `<${t.name}${attrsOut(t.name, t.attrs, removed, template)}>`;
  }
  return { html: out, removed };
}

/**
 * The check of a template before it is saved: the placeholders are replaced by a neutral token first (block tags such as `{{#if x}}checked{{/if}}`
 * may sit inside a tag), then the template must come through the allow-list unchanged in substance: anything removed is reported and refuses it.
 */
export function checkTemplate(tpl: string): string[] {
  const neutral = tpl
    .replace(/\{\{\s*(#(each|if)\b[^}]*|\/(each|if)\s*|else\s*)\}\}/g, '')
    .replace(/\{\{\{[^{}]*\}\}\}|\{\{[^{}]*\}\}/g, PLACEHOLDER_TOKEN);
  return [...new Set(sanitizeHtml(neutral, { template: true }).removed)];
}
