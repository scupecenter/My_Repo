#!/usr/bin/env node
/* Render a CW form template + data JSON to an A4 PDF with headless Chromium (Playwright).
 *   node render.js <template.tpl.html> <data.json> [out.pdf] [--png] [--verify]
 *   --png     also writes <out>-p1.png (page 1) via pdftoppm when available
 *   --verify  fails (exit 1) on: leftover "{{", horizontal overflow, header row not repeated on page 2+
 * Handlebars: the real library (npm i handlebars) is used; falls back to the 40-line mini renderer below. */
const fs = require('fs'), path = require('path'), cp = require('child_process');

function req(name, fallbacks) {
  try { return require(name); } catch (e) {}
  for (const p of fallbacks) { try { return require(path.join(p, name)); } catch (e) {} }
  return null;
}
const playwright = req('playwright', [process.env.PLAYWRIGHT_NODE_PATH || '', '/opt/node-tools/node_modules']);
if (!playwright) { console.error('playwright not found (set PLAYWRIGHT_NODE_PATH)'); process.exit(2); }
const Handlebars = process.env.RENDER_MINI ? null : req('handlebars', []);

/* ---- mini renderer: {{x}} {{{x}}} {{#each a}}..{{else}}..{{/each}} {{#if x}}..{{else}}..{{/if}} {{this}} dotted paths ---- */
function mini(tpl, ctx) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const get = (c, p) => p === 'this' ? c : p.split('.').reduce((o, k) => (o == null ? o : o[k]), c);
  const truthy = v => Array.isArray(v) ? v.length > 0 : !!v;
  function block(src, ctx) {
    let out = '', i = 0; const re = /\{\{\{(.+?)\}\}\}|\{\{#(each|if) (.+?)\}\}|\{\{(.+?)\}\}/g; let m;
    while ((m = re.exec(src))) {
      out += src.slice(i, m.index); i = re.lastIndex;
      if (m[1]) out += (get(ctx, m[1].trim()) ?? '');
      else if (m[2]) {                       // find the matching close, honouring nesting
        let depth = 1, j = i, sc = /\{\{(#(?:each|if)\b|\/(?:each|if))[^}]*\}\}/g, e; sc.lastIndex = i;
        while ((e = sc.exec(src))) { depth += e[1][0] === '#' ? 1 : -1; if (!depth) { j = e.index; break; } }
        const inner = src.slice(i, j); i = sc.lastIndex; re.lastIndex = i;
        let a = inner, b = '', d = 0, es = /\{\{(#(?:each|if)\b|\/(?:each|if)|else)[^}]*\}\}/g, x;
        while ((x = es.exec(inner))) { if (x[1][0] === '#') d++; else if (x[1][0] === '/') d--; else if (!d) { a = inner.slice(0, x.index); b = inner.slice(es.lastIndex); break; } }
        const v = get(ctx, m[3].trim());
        if (m[2] === 'if') out += block(truthy(v) ? a : b, ctx);
        else out += Array.isArray(v) && v.length ? v.map(it => block(a, typeof it === 'object' ? Object.assign({}, ctx, it) : it)).join('') : block(b, ctx);
      } else out += esc(get(ctx, m[4].trim()) ?? '');
    }
    return out + src.slice(i);
  }
  return block(tpl, ctx);
}
/* Derived fields the engine adds before rendering (the data contract only has doc.qr_svg, doc.ref_no, template.code):
   doc.qr_svg_uri  data: URI of the QR svg, used in the @page margin box
   doc.ref_no_css / template.code_css  CSS-string-safe copies (margin-box content is a CSS string, not HTML) */
function prepare(data) {
  const d = JSON.parse(JSON.stringify(data)), cssEsc = v => String(v == null ? '' : v).replace(/[\\"<>&\n\r]/g, '');
  const svg = String((d.doc && d.doc.qr_svg) || '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').replace('<svg ', '<svg width="40" height="40" ');
  d.doc = Object.assign({}, d.doc, { qr_svg_uri: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), ref_no_css: cssEsc(d.doc && d.doc.ref_no) });
  d.template = Object.assign({}, d.template, { code_css: cssEsc(d.template && d.template.code) });
  return d;
}
const renderHtml = (tpl, data) => { const d = prepare(data); return Handlebars ? Handlebars.compile(tpl)(d) : mini(tpl, d); };

async function main() {
  const args = process.argv.slice(2), flags = args.filter(a => a.startsWith('--')), pos = args.filter(a => !a.startsWith('--'));
  if (pos.length < 2) { console.error('usage: node render.js template.tpl.html data.json [out.pdf] [--png] [--verify]'); process.exit(2); }
  const [tplPath, dataPath] = pos, data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const outPdf = pos[2] || path.join('out', path.basename(tplPath).replace(/\.tpl\.html$/, '') + '.pdf');
  fs.mkdirSync(path.dirname(outPdf), { recursive: true });
  const html = renderHtml(fs.readFileSync(tplPath, 'utf8'), data);
  const problems = [];
  if (html.includes('{{')) problems.push('unreplaced "{{" in rendered HTML');
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.addStyleTag({ content: 'body{width:186mm!important;margin:0!important}' });   // printable column = A4 minus 12mm side margins
  const over = await page.evaluate(() => {
    const limit = 186 / 25.4 * 96 + 1, bad = [];
    document.querySelectorAll('.sheet *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (el.closest('svg') || el.closest('.tpl-foot')) return;
      if (r.width && (r.right > limit || (el.scrollWidth > el.clientWidth + 1 && /table-cell|block/.test(getComputedStyle(el).display) && getComputedStyle(el).overflow !== 'visible')))
        bad.push(el.tagName + '.' + el.className + ' right=' + Math.round(r.right) + 'px: ' + (el.textContent || '').trim().slice(0, 40));
    });
    return bad.slice(0, 10);
  });
  if (over.length) problems.push('overflow: ' + over.join(' | '));
  await page.pdf({ path: outPdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
  await browser.close();
  const info = cp.spawnSync('pdfinfo', [outPdf], { encoding: 'utf8' }).stdout || '';
  const pages = +((info.match(/Pages:\s+(\d+)/) || [])[1] || 0);
  console.log(`${outPdf}  pages=${pages}`);
  if (flags.includes('--png')) {
    const base = outPdf.replace(/\.pdf$/, '-p1');
    const r = cp.spawnSync('pdftoppm', ['-png', '-r', '80', '-f', '1', '-l', '1', '-singlefile', outPdf, base]);
    if (r.status) problems.push('pdftoppm failed (install poppler-utils for --png)'); else console.log(base + '.png');
  }
  if (flags.includes('--verify')) {
    const txt = n => cp.spawnSync('pdftotext', ['-f', n, '-l', n, '-layout', outPdf, '-'], { encoding: 'utf8' }).stdout || '';
    const all = txt(1) + (pages > 1 ? Array.from({ length: pages - 1 }, (_, i) => txt(i + 2)).join('') : '');
    if (all.includes('{{') || all.includes('}}')) problems.push('"{{" left in PDF text');
    for (let n = 2; n <= pages; n++) {
      const t = txt(n);
      if (/<th|Item Description/.test('') ) {}
      const hasTable = /\n\s*\d+\s+\S/.test(t) && /Item Description|No\./.test(t);
      if (/^\s*\d+\s+\S.*\d/m.test(t) && !/Item Description|Snag No\.|Item Code/.test(t) && /Page \d+ of/.test(t))
        problems.push(`page ${n}: table rows without repeated header`);
    }
    if (!new RegExp(`Page ${pages} of ${pages}`).test(txt(pages))) problems.push('footer "Page X of Y" missing on last page');
    console.log('verify:', problems.length ? problems : 'OK');
  }
  if (problems.length && flags.includes('--verify')) process.exit(1);
  else if (problems.length) console.warn('warnings:', problems);
}
main().catch(e => { console.error(e); process.exit(1); });
