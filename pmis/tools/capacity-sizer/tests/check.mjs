// Run: node tests/check.mjs   (NODE_PATH=$(npm root -g) if playwright is global)
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL0 = pathToFileURL(path.join(dir, 'index.html')).href;

let fails = 0, passes = 0;
const ok = (c, m) => { if (c) { passes++; console.log('  ok   ' + m); } else { fails++; console.log('  FAIL ' + m); } };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(URL0, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.computeSizing === 'function');

const bad = (o, p = '') => {
  const out = [];
  (function walk(v, k) {
    if (typeof v === 'number') { if (!Number.isFinite(v) || v < 0) out.push(k + '=' + v); }
    else if (v && typeof v === 'object' && k !== 'inputs') for (const x in v) walk(v[x], k + '.' + x);
  })(o, p);
  return out;
};

console.log('numbers sane');
const cases = await page.evaluate(() => {
  const P = window.SIZER_PRESETS, D = window.SIZER_DEFAULTS;
  const r = {};
  for (const k of ['pilot', 'full', 'growth']) r[k] = window.computeSizing(Object.assign({}, D, P[k]));
  r.defaults = window.computeSizing();
  r.empty = window.computeSizing({});
  return r;
});
for (const k in cases) ok(bad(cases[k]).length === 0, `${k}: no NaN/negative ${bad(cases[k]).join(',')}`);
ok(cases.defaults.SH === 1440, 'defaults: sites at horizon = 1440');
ok(cases.defaults.totals.prod.vcpu === 13, 'defaults: prod vCPU 13');

console.log('scaling');
const sc = await page.evaluate(() => {
  const a = window.computeSizing({ C: 100 }), b = window.computeSizing({ C: 200 }), c = window.computeSizing({ C: 1000 });
  const s1 = window.computeSizing({ S: 1000 }), s2 = window.computeSizing({ S: 2000 });
  return { a: a.totals.prod, b: b.totals.prod, c: c.totals.prod, s1: [s1.storageHorizonGB, s1.backupLocalGB], s2: [s2.storageHorizonGB, s2.backupLocalGB] };
});
ok(sc.b.vcpu > sc.a.vcpu || sc.c.vcpu > sc.a.vcpu, `vCPU grows with C (${sc.a.vcpu} -> ${sc.b.vcpu} -> ${sc.c.vcpu})`);
ok(sc.c.ram > sc.a.ram && sc.c.vcpu > sc.a.vcpu, `vCPU and RAM grow at high C (C=1000: ${sc.c.vcpu}/${sc.c.ram})`);
ok(sc.b.vcpu > sc.a.vcpu && sc.b.ram > sc.a.ram, `C doubled: prod vCPU and RAM both grow (${sc.a.vcpu}/${sc.a.ram} -> ${sc.b.vcpu}/${sc.b.ram})`);
ok(sc.s2[0] > sc.s1[0] && sc.s2[1] > sc.s1[1], 'storage and backup grow with S');

console.log('UI');
await page.fill('#in-rto', '0.1');
ok(await page.locator('#warnings [data-code^="restore"]').count() === 1, 'restore warning appears at RTO 0.1 h');
await page.fill('#in-rto', '4');
ok(await page.locator('#warnings [data-code^="restore"]').count() === 0, 'restore warning gone at RTO 4 h');

const tAr = await page.title(), h1Ar = await page.textContent('#title');
ok(await page.getAttribute('html', 'dir') === 'rtl', 'default is RTL Arabic');
await page.click('#langBtn');
const tEn = await page.title();
ok(tEn !== tAr && tEn === 'GSDN PMIS — Infrastructure Sizing Tool' && (await page.textContent('#title')) !== h1Ar, `AR->EN toggle changes title ("${tEn}")`);
ok(await page.getAttribute('html', 'dir') === 'ltr', 'EN is LTR');
ok(/v1\.0/.test(await page.textContent('#subtitle')), 'version label in header');
await page.click('#langBtn');

console.log('URL hash');
await page.fill('#in-S', '1500'); await page.fill('#in-C', '150');
const hash = await page.evaluate(() => location.hash);
ok(/S=1500/.test(hash) && /C=150/.test(hash), `hash holds inputs (${hash})`);
const p2 = await ctx.newPage();
await p2.goto(URL0 + hash, { waitUntil: 'domcontentloaded' });
ok(await p2.inputValue('#in-S') === '1500' && await p2.inputValue('#in-C') === '150', 'hash round-trips on reload');
await p2.close();

console.log('JSON save/load');
await page.fill('#h-org', 'Aljeel IT'); await page.fill('#h-scen', 'Test A');
const saved = await page.evaluate(() => JSON.stringify(window.exportScenario()));
const sj = JSON.parse(saved);
ok(sj.tool === 'gsdn-pmis-sizing' && sj.version === 1 && sj.inputs.S === 1500 && sj.header.org === 'Aljeel IT', 'exported JSON has tool, version, inputs, header');
await page.evaluate(() => window.importScenarioText(JSON.stringify({ tool: 'gsdn-pmis-sizing', version: 1, inputs: { S: 10 } })));
ok(await page.inputValue('#in-S') === '10', 'import changes state');
const good = await page.evaluate(t => window.importScenarioText(t), saved);
ok(good && await page.inputValue('#in-S') === '1500' && await page.inputValue('#in-C') === '150' && await page.inputValue('#h-org') === 'Aljeel IT', 'JSON round-trip restores inputs and header');
const rej = await page.evaluate(() => [
  'not json', '[]', '{}',
  JSON.stringify({ tool: 'gsdn-pmis-sizing', version: 2, inputs: {} }),
  JSON.stringify({ tool: 'gsdn-pmis-sizing', version: 1, inputs: { bogus: 1 } }),
  JSON.stringify({ tool: 'gsdn-pmis-sizing', version: 1, inputs: { S: 'abc' } }),
  JSON.stringify({ tool: 'gsdn-pmis-sizing', version: 1, inputs: { S: -5 } }),
  JSON.stringify({ tool: 'gsdn-pmis-sizing', version: 1, inputs: { util: 500 } }),
  JSON.stringify({ tool: 'gsdn-pmis-sizing', version: 1, inputs: {}, header: { evil: 'x' } })
].map(t => window.importScenarioText(t)));
ok(rej.every(x => x === false), `malformed/invalid files rejected (${rej.join(',')})`);
ok(await page.inputValue('#in-S') === '1500', 'state unchanged after rejection');
ok(/\S/.test(await page.textContent('#msg')) && await page.getAttribute('#msg', 'class') === 'err', 'error message shown');

console.log('scenarios');
await page.fill('#h-scen', 'A'); await page.click('#bScen');
await page.fill('#in-S', '2000'); await page.fill('#h-scen', 'B'); await page.click('#bScen');
await page.fill('#h-scen', 'C'); await page.click('#bScen');
await page.fill('#h-scen', 'D'); await page.click('#bScen');
ok(await page.locator('#slist li button[data-sload]').count() === 3, 'max 3 scenarios kept');
ok(await page.locator('#cmpTbl thead th').count() === 5, 'comparison table: label + current + 3');
ok((await page.innerHTML('#report')).includes('<th class="n">B</th>'), 'comparison is in the printable report');
await page.reload({ waitUntil: 'domcontentloaded' });
ok(await page.locator('#slist li button[data-sload]').count() === 3, 'scenarios persist in localStorage');
ok(errors.length === 0, 'no page errors ' + errors.join('|'));

console.log('screenshots');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(URL0, { waitUntil: 'domcontentloaded' });
await page.emulateMedia({ colorScheme: 'light' });
await page.fill('#h-org', 'Aljeel IT'); await page.fill('#h-by', 'IT Planning'); await page.fill('#h-scen', 'Full rollout');
await page.click('#bScen');
await page.screenshot({ path: path.join(dir, 'screenshot-ar.png'), fullPage: true });
await page.emulateMedia({ colorScheme: 'dark' });
await page.click('#langBtn');
await page.screenshot({ path: path.join(dir, 'screenshot-en-dark.png'), fullPage: true });
await page.emulateMedia({ media: 'print' });
const pdf = await page.pdf({ format: 'A4' });
ok(pdf.length > 5000, `print/PDF renders (${pdf.length} bytes)`);
const hidden = await page.evaluate(() => getComputedStyle(document.querySelector('section.inputs')).display === 'none' && getComputedStyle(document.getElementById('report')).display === 'block');
ok(hidden, 'print: UI hidden, report shown');

await browser.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
