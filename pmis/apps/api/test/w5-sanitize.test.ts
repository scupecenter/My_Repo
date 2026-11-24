import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formData, renderForm } from '../src/library/render';
import { checkTemplate, sanitizeHtml } from '../src/library/sanitize';

/**
 * W5 (contract 0.15.70): the allow-list of the Library forms, without a database. The payloads are those a regex deny-list lets through (security
 * review of 2026-11-24): every one is stripped from a filled copy and refuses a template on save. The owner's CW forms pass unchanged in substance.
 */
const STRIPPED: [string, RegExp][] = [
  ['<svg/onload=alert(1)>x', /svg|onload/i],
  ['<a href="java&#115;cript:alert(1)">x</a>', /href|javascript/i],
  ['<img src=x/onerror=alert(1)>', /onerror|src=/i],
  ['<img src="x"/onerror="alert(1)">', /onerror|src=/i],
  ['<iframe srcdoc="<script>alert(1)</script>"></iframe>', /iframe|srcdoc|script/i],
  ['<div srcdoc="x">a</div>', /srcdoc/i],
  ['<img src="data:text/html;base64,PHNjcmlwdD4=">', /data:text/i],
  ['<style>body{background:url(https://example.test/x)}</style>', /example\.test/i],
  ['<style>@import url(//example.test/a.css);</style>', /@import|example/i],
  ['<p style="background:u\\72l(x)">t</p>', /\\72/],
  ['<p style="width:expression(alert(1))">t</p>', /expression/i],
  ['<style>p{}</style><svg><style><img src=x onerror=alert(1)></style></svg>', /onerror|<img/i],
  ['<form action="https://example.test"><input type="submit"></form>', /form|submit/i],
  ['<link rel="stylesheet" href="https://example.test/a.css">', /link|example/i],
  ['<meta http-equiv="refresh" content="0;url=https://example.test">', /refresh|http-equiv/i],
  ['<!--><img src=x onerror=alert(1)>-->', /onerror/i],
  ['<<script>script>alert(1)<</script>/script>', /<script/i],
  ['<object data="x"></object><embed src="x"><base href="https://example.test/">', /object|embed|base/i],
  ['<style>p{background:\u0001("javascript:alert(1)")}</style>', /javascript/i],
];

describe('W5: the allow-list of the forms (sanitize.ts)', () => {
  for (const [input, bad] of STRIPPED) {
    it(`strips ${input.slice(0, 60)}`, () => {
      const r = sanitizeHtml(input);
      expect(r.html).not.toMatch(bad);
      expect(r.removed.length + (r.html.includes('&lt;') ? 1 : 0)).toBeGreaterThan(0);
      // and the template check refuses it
      expect(checkTemplate(input).length, input).toBeGreaterThan(0);
    });
  }

  it('keeps printable markup, escapes text and re-serializes attributes', () => {
    const r = sanitizeHtml('<!DOCTYPE html><html><head><meta charset="utf-8"><title>T & co</title><style>td{color:red}</style></head><body>'
      + '<table border="1"><tr><td colspan="2" class="a" style="width:10px">1 < 2 & 3</td></tr></table><input type="checkbox" checked><img src="data:image/png;base64,iVBORw0KGgo=" alt="logo"></body></html>');
    expect(r.removed).toEqual([]);
    expect(r.html).toContain('<td colspan="2" class="a" style="width:10px">1 &lt; 2 &amp; 3</td>');
    expect(r.html).toContain('<input type="checkbox" checked>');
    expect(r.html).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo">');
    expect(r.html).toContain('<style>td{color:red}</style>');
  });

  it('an attribute value is decoded and re-escaped: a quote inside it never closes it', () => {
    const r = sanitizeHtml('<p title="a&quot; onmouseover=&quot;alert(1)">t</p>');
    expect(r.html).toBe('<p title="a&quot; onmouseover=&quot;alert(1)">t</p>');
  });

  it('placeholders and block tags inside a tag pass the template check; the filled copy is clean', () => {
    const tpl = '<p class="{{site.code}}">{{#if a}}<b>{{x}}</b>{{/if}}</p><input type="checkbox" {{#if a}}checked{{/if}}><img src="{{{doc.qr_svg_uri}}}">';
    expect(checkTemplate(tpl)).toEqual([]);
    const out = sanitizeHtml(renderForm(tpl, formData({ a: true, x: '<script>alert(1)</script>', site: { code: 'S1" onclick="x' } }, {})).html);
    expect(out.html).not.toMatch(/<script|onclick="x/);
    expect(out.html).toContain('<input type="checkbox" checked>');
  });

  it("the owner's CW forms (design/forms/templates) pass the template check", () => {
    for (const f of ['DN', 'RN', 'PAC', 'FAC']) {
      const tpl = readFileSync(join(__dirname, '..', '..', '..', 'design', 'forms', 'templates', `GSDN_CW_${f}.tpl.html`), 'utf8');
      expect(checkTemplate(tpl), f).toEqual([]);
    }
  });
});
